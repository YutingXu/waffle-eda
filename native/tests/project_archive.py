"""Ordinary Git, filesystem and ZIP reader integration. Everything below is synthetic."""
import hashlib
import json
import os
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest
from unittest.mock import patch
import zipfile

NATIVE=Path(__file__).resolve().parents[1]
sys.path.insert(0,str(NATIVE))
import import_sources as sources
# This test has the same basename as the helper, but is launched as __main__.
import project_archive as archive


def git(root,*args):
    return subprocess.run(["git","-c","user.name=Fixture","-c","user.email=fixture@example.invalid",
        "-c","core.hooksPath="+os.devnull,"-c","commit.gpgSign=false","-C",str(root),*args],check=True,
        stdout=subprocess.PIPE,stderr=subprocess.PIPE).stdout.decode().strip()


class ProjectArchive(unittest.TestCase):
    def test_sources_and_plain_merge(self):
        with tempfile.TemporaryDirectory() as temp:
            tmp=Path(temp).resolve();base=tmp/"seed";base.mkdir();git(base,"init","-b","main")
            source=base/"source.kicad_pcb";data=b"synthetic original\n";source.write_bytes(data)
            proj=base/"Board";side=proj/".waffle";side.mkdir(parents=True)
            ignore="/cache/\n/previews/\n/history/\n/journal/\n/local/\n"
            (side/".gitignore").write_text(ignore)
            git(base,"add",".");git(base,"commit","-m","Source and project")
            first=git(base,"rev-parse","HEAD")
            sha=hashlib.sha256(data).hexdigest()
            locator=sources.locate(proj,source,sha,len(data))
            self.assertEqual(locator,{"algorithm":"sha1","commit":first,"path":source.name})
            alias=tmp/"elsewhere";alias.symlink_to(tmp, target_is_directory=True)
            self.assertEqual(sources.locate(proj,alias/"seed"/source.name,sha,len(data)),locator)
            (base/"alias.kicad_pcb").symlink_to(source)
            with self.assertRaisesRegex(ValueError,"without links"):
                sources.locate(proj,base/"alias.kicad_pcb",sha,len(data))
            (base/"alias.kicad_pcb").unlink()
            source.write_bytes(b"new revision\n");git(base,"add",source.name);git(base,"commit","-m","New source")
            source.write_bytes(data)  # Dirty worktree still equals a historical regular Git blob.
            self.assertEqual(sources.locate(proj,source,sha,len(data))["commit"],first)
            unmatched=b"not in any commit\n";source.write_bytes(unmatched)
            with self.assertRaisesRegex(ValueError,"no matching"):sources.locate(proj,source,hashlib.sha256(unmatched).hexdigest(),len(unmatched))
            self.assertEqual(sources.read_pinned(proj,locator,sha,len(data)),data)
            source.unlink();self.assertEqual(sources.read_pinned(proj,locator,sha,len(data)),data)
            for p in [base/"loose.kicad_pcb",tmp/"outside.kicad_pcb"]:
                p.write_bytes(data);self.assertIsNone(sources.locate(proj,p,sha,len(data)))
            other=tmp/"worktree";git(base,"worktree","add","--detach",str(other),first)
            self.assertIsNone(sources.locate(proj,other/source.name,sha,len(data)))
            git(base,"restore",source.name)
            (base/"loose.kicad_pcb").unlink()
            for name in ["cache","previews","history","journal","local"]:
                folder=side/name;folder.mkdir();(folder/"probe").write_bytes(data)
            self.assertEqual(git(base,"status","--porcelain"),"")
            self.assertFalse(sources.ignore_notice(proj))
            (base/".gitignore").write_text("Board/.waffle/\n");self.assertTrue(sources.ignore_notice(proj));(base/".gitignore").unlink()
            clone=tmp/"clone";git(tmp,"clone","--local",str(base),str(clone))
            board=clone/"Board";orig=clone/source.name;doc=board/"A.wsch";second=board/"B.wsch"
            for p in [doc,second]:p.write_text('{"kind":"schematic","formatVersion":"2.0","id":"'+p.stem+'"}\n')
            git(clone,"add",".");git(clone,"commit","-m","Sheets")
            git(clone,"switch","-c","left");doc.write_text(doc.read_text()+'{"kind":"label","id":"left"}\n');git(clone,"add",".");git(clone,"commit","-m","Left")
            git(clone,"switch","main");git(clone,"switch","-c","right");second.write_text(second.read_text()+'{"kind":"label","id":"right"}\n');git(clone,"add",".");git(clone,"commit","-m","Right")
            git(clone,"merge","--no-edit","left")
            self.assertEqual(git(clone,"status","--porcelain"),"");self.assertTrue(orig.is_file())
            with self.assertRaisesRegex(ValueError,"Missing retained source"):
                sources.read_pinned(tmp,locator,sha,len(data))

    def test_publish_portable_snapshot(self):
        with tempfile.TemporaryDirectory() as temp:
            tmp=Path(temp).resolve(); stage=tmp/"source";stage.mkdir()
            manifest="Board.waffle";doc="Sheet.wsch";project=b'{"kind":"project","formatVersion":"2.0","id":"p","name":"Board"}\n{"kind":"document","id":"s","docKind":"schematic","name":"Sheet","path":"Sheet.wsch"}\n'
            sheet=b'{"kind":"schematic","formatVersion":"2.0","id":"s"}\n'
            rows=[{"path":manifest,"data":project},{"path":doc,"data":sheet},{"path":archive.IGNORE,"data":b"/cache/\n# custom\n"}]
            for row in rows:
                target=stage/row["path"];target.parent.mkdir(parents=True,exist_ok=True);target.write_bytes(row["data"])
            version=archive.verify(stage,manifest,[r["path"] for r in rows])
            with self.assertRaisesRegex(ValueError,"Missing required"):
                archive.verify(stage,manifest,[manifest,archive.IGNORE])
            extra=stage/"Untracked.wsch";extra.write_bytes(sheet)
            with self.assertRaisesRegex(ValueError,"unreferenced"):
                archive.verify(stage,manifest,[r["path"] for r in rows]+[extra.name])
            # Place the files in a regular DEFLATED archive with an independent implementation,
            # then exercise the browser archive parser/codec on those exact bytes.
            zipped=tmp/"fixture.zip"
            with zipfile.ZipFile(zipped,"w",zipfile.ZIP_DEFLATED) as z:
                for row in rows:z.writestr("Board/"+row["path"],row["data"])
            script="""for(const n of ['core/model','project/source-file','project/obsolete-project','formats/format-2-codec','formats/format-2-units','formats/format-2-values','formats/format-2-model','formats/format-2-closure','formats/import-sidecars','core/zip','project/project-archive'])require('./app/'+n+'.js');
(async()=>{const z=AtriumProjectArchive.zipDirectory(require('fs').readFileSync(process.argv[1])); const p=await z.projects();
const x=await AtriumProjectArchive.extract(z,p[0],AtriumProjectArchive.verifyClosure);
const read=path=>x.files.get(path),closure=await AtriumProjectArchive.verifyClosure({manifestPath:x.manifest,read});
const saved=await AtriumProjectArchive.archive({...closure,read});require('fs').writeFileSync(process.argv[2],saved.bytes);
process.stdout.write(x.version)})().catch(e=>{console.error(e);process.exit(1)})"""
            outgoing=tmp/"from-waffle.zip"
            result=subprocess.run(["node","-e",script,str(zipped),str(outgoing)],cwd=NATIVE.parent,check=True,capture_output=True)
            self.assertEqual(result.stdout.decode(),version)
            with zipfile.ZipFile(outgoing) as z:
                self.assertIsNone(z.testzip())
                self.assertEqual({name:z.read(name) for name in z.namelist()},
                                 {"Board/"+row["path"]:row["data"] for row in rows})
            (tmp/"BOARD").mkdir();user=tmp/"BOARD"/"user-file";user.write_text("keep")
            linked_parent=tmp/"linked-parent";linked_parent.symlink_to(tmp/"BOARD",target_is_directory=True)
            with self.assertRaisesRegex(ValueError,"without links"):
                archive.install(linked_parent,manifest,rows,version)
            self.assertEqual(list((tmp/"BOARD").iterdir()),[user])
            reads = []
            read_bytes = Path.read_bytes

            def record_read(path):
                if path.parent.name.startswith(".waffle-extract-"):
                    reads.append(path.name)
                return read_bytes(path)

            with patch.object(Path, "read_bytes", record_read):
                dest=archive.install(tmp,manifest,rows,version)
            self.assertEqual(reads, [manifest, doc])
            self.assertEqual(dest.parent.name,"Board (2)");self.assertEqual(user.read_text(),"keep")
            self.assertEqual(archive.verify(dest.parent,manifest,[r["path"] for r in rows]),version)
            self.assertEqual((dest.parent/archive.IGNORE).read_bytes(),rows[2]["data"])
            with self.assertRaisesRegex(ValueError,"differs"):archive.install(tmp,manifest,rows,"0"*64)
            self.assertFalse((tmp/"Board (3)").exists())
            with self.assertRaisesRegex(ValueError,"cancelled"):
                archive.command("convert",{"parent":str(tmp),"manifest":manifest,"files":rows,"version":version,
                                           "guardFile":str(tmp / "revoked-import-session")})
            self.assertFalse((tmp/"Board (3)").exists())

            def change_before_publication():
                member = next(tmp.glob(".waffle-extract-*")) / doc
                member.write_bytes(sheet.replace(b'"s"', b'"t"'))

            with self.assertRaisesRegex(ValueError, "staged archive changed"):
                archive.install(tmp,manifest,rows,version,before_publish=change_before_publication)
            self.assertFalse((tmp/"Board (3)").exists())

            def change_after_verification_read(path):
                data = read_bytes(path)
                if path.name == doc and path.parent.name.startswith(".waffle-extract-"):
                    path.write_bytes(sheet.replace(b'"s"', b'"t"'))
                return data

            with patch.object(Path, "read_bytes", change_after_verification_read):
                with self.assertRaisesRegex(ValueError, "staged archive changed"):
                    archive.install(tmp,manifest,rows,version)
            self.assertFalse((tmp/"Board (3)").exists())
            self.assertFalse(any(p.name.startswith(".waffle-extract-") for p in tmp.iterdir()))
            # A save panel names the exact folder; a parent chooser suggests a stem that claims a suffix.
            exact=archive.command("convert",{"parent":str(tmp),"manifest":manifest,"files":rows,"version":version,
                                             "destinationName":"Board copy"})
            self.assertEqual(Path(exact["manifest"]),tmp/"Board copy"/manifest)
            with self.assertRaisesRegex(FileExistsError,"already exists"):
                archive.install(tmp,manifest,rows,version,destination_name="Board copy")
            suffixed=archive.install(tmp,manifest,rows,version,folder_stem="Board copy")
            self.assertEqual(suffixed.parent.name,"Board copy (2)")
            with self.assertRaisesRegex(ValueError,"Invalid archive path"):
                archive.install(tmp,manifest,rows,version,destination_name="../escape")
            self.assertFalse(any(p.name.startswith(".waffle-extract-") for p in tmp.iterdir()))

    def test_first_save_destination_outside_the_source(self):
        # The first Save of an import never suggests the source project folder or anything inside it.
        with tempfile.TemporaryDirectory() as temp:
            tmp=Path(temp).resolve()
            repo=tmp/"repos"/"Sensor Board";repo.mkdir(parents=True)
            source=repo/"Sensor Board.PrjPcb";source.write_bytes(b"synthetic")
            before=sorted(p.relative_to(tmp) for p in tmp.rglob("*"))
            # No recent Waffle project: beside the source project folder, whose name is taken.
            folder,name=archive.suggest_destination(source,[],"Sensor Board")
            self.assertEqual((folder,name),(tmp/"repos","Sensor Board (2)"))
            self.assertFalse(archive.within(folder/name,repo))
            out=archive.command("suggest",{"source":str(source),"recent":[],"stem":"Sensor Board"})
            self.assertEqual(out,{"folder":str(tmp/"repos"),"name":"Sensor Board (2)"})
            # The most recent Waffle project's location wins; missing folders and other files are skipped.
            work=tmp/"waffle"/"Old";work.mkdir(parents=True)
            recent=[str(tmp/"gone"/"X"/"X.waffle"),str(tmp/"repos"/"a.PrjPcb"),str(work/"Old.waffle")]
            self.assertEqual(archive.suggest_destination(source,recent,"Sensor Board"),(tmp/"waffle","Sensor Board"))
            # A recent project that lived inside the source folder falls back to beside it.
            inner=repo/"Nested"/"Nested.waffle";inner.parent.mkdir()
            self.assertEqual(archive.suggest_destination(source,[str(inner)],"Sensor Board")[0],tmp/"repos")
            inner.parent.rmdir()
            # Unusable stems fall back to the default project name; the helper never writes.
            self.assertEqual(archive.suggest_destination(source,[],"..")[1],"Project")
            self.assertEqual(sorted(p.relative_to(tmp) for p in tmp.rglob("*")),before+[Path("waffle"),Path("waffle/Old")])


if __name__=="__main__":
    unittest.main()
