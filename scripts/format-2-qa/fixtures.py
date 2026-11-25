"""Generate canonical synthetic controls, never measurements of an imported production design."""
import argparse
import json
from pathlib import Path
import tempfile

from crash import SHEET, LABEL, lines, digest
from gitmetrics import Repo

PROJECT = "Sensor Board.waffle"
POWER = "Power.wsch"
HEADER = {"kind": "project", "formatVersion": "2.0", "id": "p1", "name": "Sensor Board"}


def ref(docid, stem="Power", which="schematic"):
    return {"kind": "document", "id": docid, "docKind": which, "name": stem,
            "path": stem + (".wpcb" if which == "pcb" else ".wsch")}


def write_scale(folder, references, multiplier=1):
    folder.mkdir()
    visible = lines(SHEET, LABEL)
    assert len(visible) == 121 and digest(visible) == "97ff75921360fc03cc25687c26d8635d8ab222241d0fa2cfe1af94e8f2300e7c"
    (folder / POWER).write_bytes(visible)
    refs = [ref("s1")]
    cold = 0
    for n in range(references - 1):
        stem = "Cold-%04d" % n
        docid = "z%04d" % n
        row = ref(docid, stem)
        refs.append(row)
        label = {**LABEL, "id": "n-" + docid}
        header = {**SHEET, "id": docid}
        base = lines(header, label)
        label["text"] += "X" * (len(base) * (multiplier - 1))
        body = lines(header, label)
        assert len(body) == len(base) * multiplier
        (folder / row["path"]).write_bytes(body)
        cold += len(body)
    project = lines(HEADER, *refs)
    (folder / PROJECT).write_bytes(project)
    assert len(lines(HEADER, refs[0])) == 160 and len(project) - 160 <= 512 * 1024
    return {"manifestBytes": len(project), "visibleBytes": len(visible), "coldBytes": cold,
            "refs": references, "path": PROJECT}


def verify_git(parent):
    folder = parent / "checkout"
    write_scale(folder, 1)
    repo = Repo(folder)
    repo.initialize()
    sheet = folder / POWER
    manifest_bytes = (folder / PROJECT).read_bytes()
    git_rows = []
    def checkpoint(n, expected, paths):
        row, changed = repo.diff()
        assert row == expected and changed == paths, (row, changed)
        repo.commit(n)
        git_rows.append(row)
    single = {"files": 1, "additions": 1, "deletions": 1}
    for n in (1, 2):
        sheet.write_bytes(lines(SHEET, {**LABEL, "text": "SENSE-%d" % n}))
        checkpoint(n, single, [POWER])
    assert (folder / PROJECT).read_bytes() == manifest_bytes
    # Real Git three-way merges: one intervening unchanged record separates two authored edit sites.
    records = [{**LABEL, "id": "n%d" % i, "text": "BASE%d" % i} for i in range(7)]
    sheet.write_bytes(lines(SHEET, *records))
    board = folder / "Main.wpcb"
    board.write_bytes(lines({"kind": "pcb", "formatVersion": "2.0", "id": "b1"},
                            {"kind": "part", "id": "q1", "at": [0, 0]}))
    (folder / PROJECT).write_bytes(lines(HEADER, ref("b1", "Main", "pcb"), ref("s1")))
    repo.commit(3)
    for n in (4, 5):
        board.write_bytes(board.read_bytes().replace(('"at":[%d,0]' % (127000 * (n - 4))).encode(),
                                                    ('"at":[%d,0]' % (127000 * (n - 3))).encode()))
        checkpoint(n, single, [board.name])
    for n in (6, 7):
        with board.open("ab") as out:
            out.write(lines({"kind": "track", "id": "t%d" % n, "points": [[0, 0], [254000, 0]]}))
        checkpoint(n, {"files": 1, "additions": 1, "deletions": 0}, [board.name])
    def merge(left, right, succeeds, name):
        current = repo.run("rev-parse", "HEAD").stdout.decode().strip()
        repo.run("switch", "-q", "-c", "side-" + name)
        left()
        repo.commit(10)
        repo.run("switch", "-q", "baseline")
        right()
        repo.commit(11)
        merged = repo.run("merge", "--no-edit", "side-" + name, check=False)
        assert (merged.returncode == 0) == succeeds, name
        if not succeeds:
            assert repo.run("diff", "--name-only", "--diff-filter=U").stdout == (POWER + "\n").encode()
            repo.run("merge", "--abort")
        # This directory was created expressly for the current test.
        repo.run("reset", "--hard", current)
    def change(path, old, new):
        def apply():
            source = path.read_bytes()
            assert source.count(old) == 1
            path.write_bytes(source.replace(old, new))
        return apply
    merge(change(sheet, b"BASE0", b"LEFT"), change(sheet, b"BASE6", b"RIGHT"), True, "nonadjacent")
    merge(change(sheet, b"BASE0", b"LEFT"),
          change(board, b'"id":"q1","at":[254000,0]', b'"id":"q1","at":[255000,0]'), True, "documents")
    merge(change(sheet, b"BASE0", b"LEFT"), change(sheet, b"BASE0", b"RIGHT"), False, "same-record")
    # Multiple independent renames change two non-adjacent membership rows without rewriting
    # IDs or document bytes. Exercise Git's normal rename detector across two commits per side.
    rename=parent/"rename-checkout"
    write_scale(rename,7)
    r=Repo(rename);r.initialize()
    def renumber(stem,newstem,commit):
        r.run("mv","--",stem+".wsch",newstem+".wsch")
        manifest=rename/PROJECT
        rows=manifest.read_bytes().splitlines(keepends=True)
        n=0
        for k,raw in enumerate(rows):
            obj=json.loads(raw)
            if obj.get("path")==stem+".wsch":
                obj.update(name=newstem,path=newstem+".wsch");rows[k]=lines(obj);n+=1
        assert n==1
        manifest.write_bytes(b"".join(rows));r.commit(commit)
    r.run("switch","-q","-c","renamed-left")
    renumber("Power","Supply",1);renumber("Supply","Analog",2)
    r.run("switch","-q","baseline")
    renumber("Cold-0005","Remote",3);renumber("Remote","Digital",4)
    r.run("merge","--no-edit","renamed-left")
    refs=[json.loads(row) for row in (rename/PROJECT).read_bytes().splitlines()][1:]
    assert not r.run("status","--porcelain","-z").stdout
    assert {v["path"] for v in refs}=={p.name for p in rename.glob("*.wsch")}
    assert (rename/"Analog.wsch").read_bytes()==lines(SHEET,LABEL) and (rename/"Digital.wsch").is_file()
    return {"ordinaryGit": repo.run("--version").stdout.decode().strip(), "wireFixtureDiffs": git_rows,
            "merges": {"differentDocuments":"clean","nonadjacentRecords":"clean","sameRecord":"conflict","repeatedUnrelatedRenames":"clean"}}


def main():
    p = argparse.ArgumentParser(description=__doc__)
    p.add_argument("root", type=Path)
    p.add_argument("--out", type=Path, required=True)
    o = p.parse_args()
    o.root.mkdir(parents=True, exist_ok=True)
    cases = {}
    for key, count, factor in [("one", 1, 1), ("hundred", 100, 1), ("thousand", 1000, 1), ("hundred-large", 100, 100)]:
        cases[key] = write_scale(o.root / key, count, factor)
    assert cases["hundred-large"]["coldBytes"] == 100 * cases["hundred"]["coldBytes"]
    assert (o.root / "hundred" / PROJECT).read_bytes() == (o.root / "hundred-large" / PROJECT).read_bytes()
    with tempfile.TemporaryDirectory(dir=o.root) as temp:
        result = verify_git(Path(temp))
    o.out.write_text(json.dumps({"scalingInputs": cases, **result}, indent=2) + "\n")


if __name__ == "__main__":
    main()
