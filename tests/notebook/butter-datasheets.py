"""Run authorized PDF.js extraction and durable metadata over actual MCP stdio."""

from hashlib import sha256
import json
import os
from pathlib import Path
import runpy
import subprocess
import tempfile

HERE = Path(__file__).resolve().parents[1]
A = runpy.run_path(str(HERE / "automation/butter-acceptance.py"))
ROOT = HERE.parent
FLAGS = ("--enable-butter", "datasheets", "--allow-write")
REGION = [0, 0, 1000000, 1000000]


def run(client, name, args=None, mode=None, denied=False):
    call = {"command": "butter.datasheets." + name, "args": args or {}}
    if mode is not None:
        call["mode"] = mode
    return client.check_tool("run_command", call, denied=denied)


def data(reply, key):
    return reply["untrusted_design_text"][key]


def coverage(project, pdf, identity, definition):
    crop = {"id":identity,"page":1,"region":[0,100000,500000,600000],"side":240}
    cases = {
        "list": ({}, "read"),
        "info": ({"id":identity}, "read"),
        "reference": ({"grant":"benchmark","version":"proposed revision"}, "plan"),
        "assign-part": ({"id":identity,"definitionId":definition}, "plan"),
        "page-link": ({"id":identity,"page":1}, "read"),
        "text": ({"id":identity,"page":1}, "read"),
        "search": ({"id":identity,"query":"ground","maxPages":1}, "read"),
        "pin-table": ({"id":identity,"page":1,"region":REGION}, "read"),
        "annotate": ({"id":identity,"page":1,"region":REGION,"type":"highlight"}, "plan"),
        "list-annotations": ({"id":identity}, "read"),
        "snip": (crop, "plan"),
    }
    descriptor = json.loads((ROOT / "app/automation/descriptors/datasheets.json").read_text())
    kinds = {entry["id"]:entry["kind"] for entry in descriptor["commands"]}
    assert set(cases) == set(kinds)
    prior = A["authored_files"](project.parent)
    modes = {}
    flags = ("--enable-butter","datasheets","--datasheet-input","benchmark=" + str(pdf))
    with A["Stdio"](A["server"](project)) as disabled, A["Stdio"](A["server"](project,*flags)) as client:
        for name,(args,mode) in cases.items():
            assert run(disabled,name,args,mode,True)["code"] == "butter_disabled"
            command = "butter.datasheets." + name
            unavailable = name == "snip" and not os.environ.get("WAFFLE_PDF_CANVAS_ROOT")
            call = {"command":command,"args":args,"mode":mode}
            result = run(client,name,args,mode,unavailable)
            cli = subprocess.run([*A["server"](project,*flags),"--cli","run_command","--args",json.dumps(call)],
                                 text=True,capture_output=True,timeout=25)
            if unavailable:
                assert result["code"] == "pdf_raster_unavailable" and cli.returncode == 1
                modes[name] = ["off"]
            else:
                assert cli.returncode == 0 and result["command"] == command and json.loads(cli.stdout)["command"] == command, cli.stderr
                modes[name] = ["off",mode,"cli" + mode.title()]
            if kinds[name] in ("edit","output"):
                assert run(client,name,args,"write",True)["code"] == "write_not_allowed"
                modes[name].append("denied")
            if kinds[name] == "edit":
                proposal = run(client,name,args,"proposal")
                path = Path(proposal["proposal_file"])
                assert path.is_relative_to(project.parent) and sha256(path.read_bytes()).hexdigest() == proposal["sha256"]
                modes[name].append("proposal")
    # Positive native writes were witnessed separately before the independent mode table.
    for name in ("reference","assign-part","annotate"):
        modes[name].append("write")
    if os.environ.get("WAFFLE_PDF_CANVAS_ROOT"):
        modes["snip"].append("write")
    assert A["authored_files"](project.parent) == prior
    return modes


def verify_portable(project, digest, original):
    code = r'''
const fs = require("node:fs/promises"), path = require("node:path"), assert = require("node:assert/strict");
for (const name of ["core/model","project/obsolete-project","project/source-file","formats/sexpr","project/revisions",
  "formats/format-2-codec","formats/format-2-units","formats/format-2-values","formats/format-2-model",
  "formats/format-2-closure","formats/import-sidecars","core/zip","project/project-archive"]) {
  require("./app/"+name+".js");
}
(async () => {
  const [manifest, original, digest] = process.argv.slice(1);
  const file="assets/"+digest, archive=AtriumProjectArchive;
  const read = async member => member === AtriumImportSidecars.IGNORE
    ? new TextEncoder().encode(AtriumImportSidecars.ignoreText) : fs.readFile(path.join(path.dirname(manifest), member));
  const checked = await archive.verifyClosure({manifestPath:path.basename(manifest),read});
  assert.ok(checked.members.some(member=>member.path===file));
  const portable = await archive.archive({...checked,read});
  const zipped = archive.zipDirectory(portable.bytes), [selected] = await zipped.projects();
  const restored = await archive.extract(zipped,selected,archive.verifyClosure);
  assert.deepEqual(Buffer.from(restored.files.get(file)),await fs.readFile(original));
  assert.deepEqual(Buffer.from(restored.files.get(path.basename(manifest))),await fs.readFile(manifest));
})().catch(error => {console.error(error.message);process.exitCode=1;});
'''
    subprocess.run(["node","-e",code,str(project),str(original),digest], cwd=ROOT, check=True, timeout=20)


def fixture(root):
    p = A["make_project"](root, {})
    # Use the existing many-file native cohort with stable UUIDs where links need them.
    manifest = p.read_text()
    manifest = manifest.replace('"sensor-interface"', '"018cc251-f400-7001-8000-000000000001"', 1)
    p.write_text(manifest, encoding="utf-8")
    return p


def main():
    with tempfile.TemporaryDirectory(prefix="waffle-datasheets-") as scratch:
        top = Path(scratch).resolve()
        os.environ["XDG_CACHE_HOME"] = str(top / "private-cache")
        os.environ["LOCALAPPDATA"] = str(top / "private-cache")
        raw = subprocess.check_output(["node", "-e",
                                      'process.stdout.write(require("./tests/support/datasheet-pdf.cjs").fixture(300))'],
                                     cwd=ROOT)
        pdf = top / "Benchmark.pdf"
        pdf.write_bytes(raw)
        digest = sha256(raw).hexdigest()
        root = top / "reference"
        project = fixture(root)
        initial = A["authored_files"](root)
        with A["Stdio"](A["server"](project)) as disabled:
            assert run(disabled, "list", denied=True)["code"] == "butter_disabled"
        assert not Path(os.environ["XDG_CACHE_HOME"]).exists()
        with A["Stdio"](A["server"](project, *FLAGS, "--enable-butter", "links",
                                    "--datasheet-input", "benchmark=" + str(pdf))) as client:
            assert run(client, "list")["total"] == 0
            assert run(client, "reference", {"path": str(pdf)}, "write", True)["code"] == "invalid_arguments"
            assert run(client, "reference", {"grant": "foreign"}, "write", True)["code"] == "datasheet_grant_required"
            plan = run(client, "reference", {"grant": "benchmark"}, "plan")
            assert data(plan, "reference")["sha256"] == digest
            assert A["authored_files"](root) == initial and not Path(os.environ["XDG_CACHE_HOME"]).exists()
            starter = {"table":"Pin,Name,Type\n1,VCC,Power\n2,GND,Power","mode":"write"}
            existing = client.check_tool("create_symbol_from_table", {**starter,"name":"Existing catalog part"})
            alternate = client.check_tool("create_symbol_from_table", {**starter,"name":"Unassigned catalog part"})

            ref = data(run(client, "reference", {"grant": "benchmark", "sourceURL": "HTTPS://EXAMPLE.COM/part.pdf"}, "write"),
                       "reference")
            identity = ref["id"]
            assert ref["sha256"] == digest and ref["sourceURL"] == "https://example.com/part.pdf" and "asset" not in ref
            assert data(run(client, "list"), "items") == [ref]
            assert run(client, "info", {"id": identity})["pages"] == 300
            table = run(client, "pin-table", {"id": identity, "page": 1, "region": REGION})
            assert data(table, "rows") == [["Pin", "Name", "Function"], ["1", "VCC", "Power"], ["2", "GND", "Ground"]]
            wizard = data(table, "wizardInput")
            assert wizard["delimiter"] == "csv"
            symbol = client.check_tool("create_symbol_from_table", {**wizard, "name": "PDF pins", "mode": "proposal"})
            assert symbol["pins"] == 2 and {pin["name"] for pin in symbol["untrusted_design_text"]["pin_list"]} == {"VCC", "GND"}
            cropped = run(client,"pin-table",{"id":identity,"page":1,"region":[0,250000,1000000,500000]})
            assert data(cropped,"rows") == [["1","VCC","Power"],["2","GND","Ground"]]
            from_crop = client.check_tool("create_symbol_from_table",{**data(cropped,"wizardInput"),"name":"Cropped PDF pins","mode":"proposal"})
            assert from_crop["pins"] == 2 and {pin["number"] for pin in from_crop["untrusted_design_text"]["pin_list"]} == {"1","2"}
            link = data(run(client, "assign-part", {"id":identity,"definitionId":existing["def_id"]}, "write"), "record")
            assert link["target"]["objectId"] == identity and link["target"]["fragment"] == "datasheet:page=1"
            assert [r["page"] for r in data(run(client, "search", {"id": identity, "query": "ground", "maxPages": 2}), "matches")] == [1]
            url = data(run(client, "page-link", {"id": identity, "page": 1}), "url")
            assert url.endswith(identity + "#datasheet:page=1")
            page_three = data(run(client,"page-link",{"id":identity,"page":3}),"url")
            rebound = client.check_tool("run_command",{"command":"butter.links.rebind","mode":"write",
                "args":{"recordId":link["id"],"url":page_three}})
            assigned = run(client,"assign-part",{"id":identity,"definitionId":existing["def_id"]},"write")
            assert assigned["changes"] == 0 and data(assigned,"record") == data(rebound,"record")
            assert data(assigned,"record")["target"]["fragment"] == "datasheet:page=3"
            if os.environ.get("WAFFLE_PDF_CANVAS_ROOT"):
                snip = run(client, "snip", {"id":identity,"page":1,"region":[0,100000,500000,600000],"side":240}, "write")
                assert snip["width"] == 240 and snip["height"] == 165 and data(snip, "link").endswith(identity + "#datasheet:page=1")
                images = [p for p in root.rglob("*.png") if p.name == "Datasheet page 1.png"]
                assert len(images) == 1 and images[0].read_bytes().startswith(b"\x89PNG\r\n\x1a\n")
            note = data(run(client, "annotate", {"id": identity, "page": 1, "region": REGION, "type": "note",
                                                "text": "Vendor pin names"}, "write"), "annotation")
            assert data(run(client, "list-annotations", {"id": identity}), "items") == [note]
            prior = A["authored_files"](root)
            assert data(run(client,"page-link",{"id":identity,"page":301}),"verification") == "unopened"
            bad = run(client,"annotate",{"id":identity,"page":301,"region":REGION,"type":"highlight"},"write",True)
            assert bad["code"] == "missing_fragment" and A["authored_files"](root) == prior
            assert run(client, "text", {"id":"wrong","page":1}, denied=True)["code"] == "missing_datasheet"
        assert pdf.read_bytes() == raw and not (root / "assets" / digest).exists()
        physical = [json.loads(line) for line in project.read_text().splitlines()]
        assert physical[0]["formatVersion"] == "2.1"
        assert {row["kind"] for row in physical} >= {"datasheetRef", "datasheetAnnotation"}
        with A["Stdio"](A["server"](project, *FLAGS, "--enable-butter", "links")) as fresh:
            resolved = fresh.check_tool("run_command", {"command":"butter.links.resolve","args":{"url":url}})
            target = data(resolved,"target")
            assert data(resolved,"status") == "found" and target["kind"] == "datasheet" and target["page"] == 1
            assert target["verification"] == "unopened" and target["objectId"] == identity
            assert run(fresh, "info", {"id": identity})["pages"] == 300

        embed_root = top / "embedded"
        embedded = fixture(embed_root)
        cache_var = "LOCALAPPDATA" if os.name == "nt" else "XDG_CACHE_HOME"
        private = os.environ[cache_var]
        blocked = top / "cache-blocked"
        blocked.write_text("the cache root cannot be opened as a directory",encoding="utf-8")
        os.environ[cache_var] = str(blocked)
        with A["Stdio"](A["server"](embedded, *FLAGS, "--datasheet-input", "benchmark=" + str(pdf))) as client:
            failed = run(client,"reference",{"grant":"benchmark"},"write",True)
            assert failed["code"] == "cache_unavailable"
            embedded_url = "https://[2001:db8::1]/"
            ref = data(run(client,"reference",{"grant":"benchmark","embed":True,
                "sourceURL":"HTTPS://[2001:0DB8:0:0:0:0:0:1]:443"},"write"),"reference")
            assert ref["sourceURL"] == embedded_url
        assert (embed_root / "assets" / digest).read_bytes() == raw
        assert ref["asset"] == {"sha256": digest, "byteLength": len(raw), "mediaType": "application/pdf"}
        verify_portable(embedded,digest,pdf)
        with A["Stdio"](A["server"](embedded, *FLAGS)) as fresh:
            assert run(fresh, "info", {"id": ref["id"]})["pages"] == 300
            assert data(run(fresh,"list"),"items")[0]["sourceURL"] == embedded_url
        assert blocked.is_file() and pdf.read_bytes() == raw
        os.environ[cache_var] = private

        second_raw = b"\xef\xbb\xbf" + subprocess.check_output(["node","-e",
            'process.stdout.write(require("./tests/support/datasheet-pdf.cjs").fixture(5,{pins:true}))'],cwd=ROOT)
        followup = top / "Second.pdf"
        followup.write_bytes(second_raw)
        second_digest = sha256(second_raw).hexdigest()
        with A["Stdio"](A["server"](embedded,*FLAGS,"--datasheet-input","second=" + str(followup))) as client:
            prior = A["authored_files"](embed_root)
            mismatched = run(client,"reference",{"grant":"second","embed":True,"existingId":ref["id"]},"write",True)
            assert mismatched["code"] == "source_changed" and A["authored_files"](embed_root) == prior
            assert run(client,"reference",{"grant":"second","embed":True},"proposal",True)["code"] == "write_not_allowed"
            extra = data(run(client,"reference",{"grant":"second","embed":True},"write"),"reference")
            assert run(client,"info",{"id":extra["id"]})["pages"] == 5
            pins = run(client,"pin-table",{"id":extra["id"],"page":1,"region":REGION})
            assert data(pins,"rows") == [["Pin Number","Name","Type"],["1","","Input"],["2","VCC","Power"]]
            assert len(data(pins,"fields")) == 9
        assert (embed_root / "assets" / second_digest).read_bytes() == second_raw
        assert (embed_root / "assets" / digest).read_bytes() == raw
        verify_portable(embedded,second_digest,followup)

        # Upgrade a reference without changing its identity or URL.
        with A["Stdio"](A["server"](project, *FLAGS, "--datasheet-input", "benchmark=" + str(pdf))) as client:
            upgraded = data(run(client,"reference",{"grant":"benchmark","existingId":identity,"embed":True},"write"),"reference")
            assert upgraded["id"] == identity and upgraded["sourceURL"] == "https://example.com/part.pdf"
        assert (root / "assets" / digest).read_bytes() == raw
        coverage_report = coverage(project,pdf,identity,alternate["def_id"])
    print("BUTTER_COMMAND_COVERAGE " + json.dumps(coverage_report,sort_keys=True))
    print("PASS actual MCP stdio: feature off, typed byte grant, cold plan, cached and embedded PDF, text, Symbol Wizard, linked snip, part field and annotation")


if __name__ == "__main__":
    main()
