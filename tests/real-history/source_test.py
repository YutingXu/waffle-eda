"""Public-format, synthetic source revisions through the same token-scoped native reader."""
import base64
import hashlib
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest

sys.path.insert(0, str(Path(__file__).resolve().parents[2] / "native"))
from git_head import BaselineError, query


class Sources(unittest.TestCase):
    def setUp(self):
        temp = tempfile.TemporaryDirectory()
        self.addCleanup(temp.cleanup)
        self.root = Path(temp.name).resolve()
        self.git("init", "-q", "-b", "main")

    def git(self, *args):
        return subprocess.check_output(["git", "-C", self.root, "-c", "user.name=Test", "-c", "user.email=test@example.invalid", *args]).decode().strip()

    def commit(self):
        self.git("add", "-A")
        self.git("commit", "-qm", "Design revision")
        return self.git("rev-parse", "HEAD")

    def test_members_and_renamed_predecessor(self):
        (self.root/"old.PrjPcb").write_text("[Document1]\nDocumentPath=A.SchDoc\n[Document2]\nDocumentPath=../external.SchLib\n")
        sheet = self.root/"A.SchDoc"
        sheet.write_bytes(b"original")
        old = self.commit()
        self.git("mv", "old.PrjPcb", "new.PrjPcb")
        moved = self.commit()
        anchor = self.root/"new.PrjPcb"
        sheet.write_bytes(b"different")
        changed = self.commit()
        (self.root/"loose.SchDoc").write_bytes(b"unselected")
        unrelated = self.commit()
        blob = lambda ref: query(anchor, "projectBlobs", {"revisions": [ref]})["blobs"][ref]
        self.assertEqual(blob(old), blob(moved))
        self.assertNotEqual(blob(moved), blob(changed))
        self.assertEqual(blob(changed), blob(unrelated))
        snap = query(anchor, "sourceRevision", {"revision": old})
        self.assertEqual([f["name"] for f in snap["files"]], ["new.PrjPcb", "A.SchDoc"])
        self.assertEqual(base64.b64decode(snap["files"][1]["data"]), b"original")
        self.assertEqual(snap["missing"], ["../external.SchLib"])
        with self.assertRaises(BaselineError):
            query(anchor, "installMergeDriver", {"confirm": True, "plan": "invalid"})
        with self.assertRaises(BaselineError):
            query(anchor, "sourceRevision", {"revision": self.git("rev-parse", "HEAD:A.SchDoc")})
        self.assertEqual([c["revision"] for c in query(anchor,"sourceLog",{"limit":4})["commits"]], [unrelated,changed,moved,old])

    def test_shared_kicad_sheet_and_local_lfs(self):
        folder = self.root/"variants"/"one"
        folder.mkdir(parents=True)
        manifest = folder/"Board.kicad_pro"
        manifest.write_text("{}")
        (folder/"Board.kicad_sch").write_text('(kicad_sch (sheet (property "Sheetfile" "../../common.kicad_sch")))')
        (self.root/"common.kicad_sch").write_text("(kicad_sch)")
        actual = b"(kicad_pcb)"
        digest = hashlib.sha256(actual).hexdigest()
        (folder/"Board.kicad_pcb").write_text("version https://git-lfs.github.com/spec/v1\noid sha256:"+digest+"\nsize "+str(len(actual))+"\n")
        head = self.commit()
        with self.assertRaisesRegex(BaselineError, "Git LFS pointer only"):
            query(manifest,"sourceRevision",{"revision":head})
        obj = self.root/".git"/"lfs"/"objects"/digest[:2]/digest[2:4]/digest
        obj.parent.mkdir(parents=True)
        obj.write_bytes(actual.replace(b"b", b"c"))
        with self.assertRaisesRegex(BaselineError, "SHA-256"):
            query(manifest,"sourceRevision",{"revision":head})
        obj.write_bytes(actual)
        files = query(manifest,"sourceRevision",{"revision":head})["files"]
        self.assertEqual([f["name"] for f in files], ["Board.kicad_pro","Board.kicad_pcb","Board.kicad_sch","common.kicad_sch"])
        self.assertEqual(base64.b64decode(files[1]["data"]),actual)


if __name__ == "__main__":
    unittest.main()
