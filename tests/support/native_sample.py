"""Author native input for headless tests and inspect it through the ordinary saved-project API."""
import atexit
import base64
import json
import os
from pathlib import Path
import shutil
import subprocess
import sys
import tempfile

ROOT = Path(__file__).resolve().parents[2]
SAMPLE = ROOT / "mcp/examples/sensor-interface/Board.waffle"
sys.path.insert(0, str(ROOT / "mcp"))
from board_runner import JavaScriptCore, load_jsc, resolve
import commands  # Registers revision snapshot modules used by the native projector.

_engine = None
_host = None


def ensure_native_host():
    """Use the real transaction service in an unpackaged macOS source checkout."""
    global _host
    if sys.platform == "darwin" and not os.environ.get("WAFFLE_FOLDER_MCP_HOST"):
        _host = tempfile.TemporaryDirectory(prefix="waffle-native-host-")
        executable = Path(_host.name) / "folder-host"
        subprocess.run(["xcrun", "swiftc", "-swift-version", "5", str(ROOT / "native/macos/FolderTransactions.swift"),
                        str(ROOT / "native/tests/folder-transaction/mcp-main.swift"), "-o", str(executable)], check=True)
        os.environ["WAFFLE_FOLDER_MCP_HOST"] = str(executable)


def evaluate(script):
    global _engine
    modules = ("format-2-model", "format-2-models", "revisions", "parts", "polygon-pour")
    library = load_jsc()
    if library:
        if _engine is None:
            _engine = JavaScriptCore(library, modules)
            atexit.register(_engine.close)
        return _engine.value_text(_engine.evaluate(script))
    setup = "".join("require(" + json.dumps(str(path)) + ");\n" for _, path in resolve(modules))
    result = subprocess.run(["node", "-"], input=setup + "console.log(" + script + ");",
                            text=True, capture_output=True, check=True)
    return result.stdout


def make_sample(directory, name="Board.waffle"):
    ensure_native_host()
    root = Path(directory)
    shutil.copytree(SAMPLE.parent, root, dirs_exist_ok=True)
    path = root / name
    if path.name != SAMPLE.name:
        (root / SAMPLE.name).rename(path)
    return path


def write_design(manifest, model):
    """Publish an explicitly authored in-memory test design into its temporary test folder."""
    ensure_native_host()
    manifest = Path(manifest)
    manifest.parent.mkdir(parents=True, exist_ok=True)
    code = """((model, manifestPath) => {
      const editor = Object.assign(Atrium.project(model.name, model.library || []), model);
      const F = AtriumFormat2, converted = AtriumFormat2Model.fromEditor(editor, {manifestPath, encodeModel: AtriumFormat2Models.encode});
      const entries = converted.files.map(({path,file}) => ({path,bytes:F.serialize(file)})).concat(converted.models, converted.assets);
      return JSON.stringify(entries.map(({path,bytes}) => {
        let text = "";
        for (let i = 0; i < bytes.length; i += 8192) text += String.fromCharCode(...bytes.subarray(i,i+8192));
        return [path,btoa(text)];
      }));
    })("""
    for name, data in json.loads(evaluate(code + json.dumps(model, ensure_ascii=True) + "," + json.dumps(manifest.name) + ")")):
        target = manifest.parent / name
        target.parent.mkdir(parents=True, exist_ok=True)
        raw = base64.b64decode(data, validate=True)
        if not target.exists() or target.read_bytes() != raw:
            target.write_bytes(raw)
    return manifest


def saved(manifest):
    from server import Server
    ensure_native_host()
    server = Server(Path(manifest))
    try:
        body = server.saved_bytes(require=True)
        return json.loads(body), server.digest
    finally:
        server.close()


def read_design(manifest):
    return saved(manifest)[0]


def revision(manifest):
    return saved(manifest)[1]


def authored_files(root):
    root = Path(root)
    return {p.relative_to(root).as_posix(): p.read_bytes() for p in root.rglob("*")
            if p.is_file() and not any(part in (".git",) or part.endswith("-outputs") for part in p.relative_to(root).parts)
            and not p.relative_to(root).as_posix().startswith((".waffle/journal/", ".waffle/local/")) and p.suffix != ".waffle-ai"}
