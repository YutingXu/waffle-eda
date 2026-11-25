"""External programs for run:external connector extensions (Linux host; macOS and Windows mirror it).

The user chooses each program: a native file picker, or a detected install path confirmed in a native
dialog (app/native-bridge/external-tools.js lists the candidates; probe() only says which exist). The page names a
tool by id and never passes a path to run.

Approval (approval_needed / record_approval; the window shows the dialog). An approval is kept for one
extension version (its id@sha256 bundle digest, as Waffle's trust and grants are), one tool and one
resolved program path (symlinks followed), and covers the extension's declared argument template:
  * The first run shows the full command and asks. Allow approves the program for that version, for
    runs whose arguments are all within the template: the run's own input file names, plain names
    matching its output patterns, and the manifest's contributes.externalTools[].args entries (literal,
    or with one {input} / {output} standing for such a name, e.g. "--out={output}").
  * A run with any other argument shows the full command and asks for that exact command (remembered
    as such for that version); a different one asks again.
  * A new extension version (another digest), another program file or a changed symlink target asks
    again. Forgetting a tool drops its approvals.

run() starts the program directly (argument list, no shell) in a new temporary folder holding the
extension's input files, with stdin closed, a minimal environment, its own process group, a timeout
(SIGTERM, then SIGKILL after two seconds), caps on stdout, stderr and the output files it returns,
and cancellation; the folder is deleted afterwards. Data crosses as base64.
"""
import base64
import fnmatch
from itertools import islice
import hashlib
import json
import os
from pathlib import Path
import re
import shutil
import signal
import stat
import subprocess
import tempfile
import threading
import time

TOOL_ID = re.compile(r"^[a-z0-9][a-z0-9_.-]{0,63}$")
FILE_NAME = re.compile(r"^[A-Za-z0-9_][A-Za-z0-9_.-]{0,127}$")
OUTPUT_PATTERN = re.compile(r"^[A-Za-z0-9_*?][A-Za-z0-9_.*?-]{0,127}$")
RUN_ID = re.compile(r"^[\w.:-]{1,200}$")
EXTENSION_ID = re.compile(r"^[A-Za-z0-9][\w.-]{0,119}$")
EXTENSION_HASH = re.compile(r"^sha256:[0-9a-f]{64}$")
PLACEHOLDERS = ("{input}", "{output}")
LIMITS = {"args": 256, "arg_chars": 4096, "files": 64, "file_bytes": 64_000_000, "outputs": 64,
          "timeout_ms": 600_000, "min_timeout_ms": 100, "output_bytes": 64_000_000, "probe": 16, "concurrent": 8, "output_entries": 4096}
KILL_GRACE = 2.0


class ToolError(ValueError):
    pass


def _text(value, limit):
    if not isinstance(value, str) or not value or len(value) > limit:
        raise ToolError("Invalid external tool request.")
    return value


def executable(path):
    """True for an absolute path to a regular executable file (not a folder)."""
    try:
        p = Path(path)
        return p.is_absolute() and p.is_file() and os.access(p, os.X_OK)
    except (OSError, ValueError):
        return False


class Store:
    """The user's choices and approvals, in one JSON file in the app's support folder."""

    def __init__(self, folder):
        self.path = Path(folder) / "external-tools.json"
        self.lock = threading.Lock()

    def _read(self):
        try:
            data = json.loads(self.path.read_text(encoding="utf-8"))
        except (OSError, ValueError):
            data = {}
        tools = data.get("tools") if isinstance(data.get("tools"), dict) else {}
        approvals = data.get("approvals") if isinstance(data.get("approvals"), list) else []
        return {"tools": {k: v for k, v in tools.items() if TOOL_ID.match(k) and isinstance(v, dict) and isinstance(v.get("path"), str)},
                "approvals": [a for a in approvals if isinstance(a, str)][:2000]}

    def _write(self, data):
        self.path.parent.mkdir(parents=True, exist_ok=True)
        tmp = self.path.with_suffix(".tmp")
        tmp.write_text(json.dumps(data, indent=1), encoding="utf-8")
        os.chmod(tmp, 0o600)
        os.replace(tmp, self.path)

    def listing(self):
        with self.lock:
            return {"tools": {k: {"path": v["path"], "name": str(v.get("name") or k)[:80]} for k, v in self._read()["tools"].items()}}

    def tool(self, tool_id):
        with self.lock:
            return self._read()["tools"].get(tool_id)

    def choose(self, tool_id, name, path):
        """Record a program the user picked or confirmed. Callers show the dialog first."""
        _text(tool_id, 64)
        if not TOOL_ID.match(tool_id) or not executable(path):
            raise ToolError("Choose a program file that can be run.")
        with self.lock:
            data = self._read()
            data["tools"][tool_id] = {"path": str(Path(path)), "name": str(name or tool_id)[:80]}
            self._write(data)
        return {"path": str(Path(path))}

    def forget(self, tool_id):
        with self.lock:
            data = self._read()
            data["tools"].pop(tool_id, None)
            data["approvals"] = [a for a in data["approvals"] if a.split("\n")[1:2] != [tool_id]]
            self._write(data)
        return True

    @staticmethod
    def approval_key(extension, tool_id, path, args=None):
        """extension: "id@sha256:..." (one version); path: the resolved program; args: the arguments of
        one exact command (a command outside the template), else the program approval."""
        key = [extension, tool_id, path]
        if args is not None:
            key.append("argv:" + hashlib.sha256(json.dumps(list(args)).encode()).hexdigest())
        return "\n".join(key)

    def approved(self, extension, tool_id, path, args=None):
        with self.lock:
            return self.approval_key(extension, tool_id, path, args) in self._read()["approvals"]

    def approve(self, extension, tool_id, path, args=None):
        with self.lock:
            data = self._read()
            key = self.approval_key(extension, tool_id, path, args)
            if key not in data["approvals"]:
                data["approvals"] = (data["approvals"] + [key])[-2000:]
                self._write(data)


def probe(paths):
    if not isinstance(paths, list):
        return []
    return [p for p in paths[:LIMITS["probe"]] if isinstance(p, str) and len(p) < 4096 and executable(p)]


def check_run(run):
    """Validate a run request from the page (AtriumAPI.cleanExternalRun already checked it there)."""
    if not isinstance(run, dict):
        raise ToolError("Invalid external tool request.")
    tool_id = _text(run.get("tool"), 64)
    if not TOOL_ID.match(tool_id):
        raise ToolError("Invalid external tool request.")
    args = run.get("args") or []
    if not isinstance(args, list) or len(args) > LIMITS["args"] or any(not isinstance(a, str) or len(a) > LIMITS["arg_chars"] or "\0" in a for a in args):
        raise ToolError("Invalid program arguments.")
    files, total = [], 0
    raw = run.get("files") or []
    if not isinstance(raw, list) or len(raw) > LIMITS["files"]:
        raise ToolError("Invalid input files.")
    for f in raw:
        if not isinstance(f, dict) or not isinstance(f.get("name"), str) or not FILE_NAME.match(f["name"]) or ".." in f["name"] or not isinstance(f.get("data"), str):
            raise ToolError("Invalid input files.")
        data = base64.b64decode(f["data"], validate=True)
        total += len(data)
        if total > LIMITS["file_bytes"]:
            raise ToolError("The input files are too large.")
        files.append((f["name"], data))
    outputs = run.get("outputs") or []
    if not isinstance(outputs, list) or len(outputs) > LIMITS["outputs"] or any(not isinstance(p, str) or not OUTPUT_PATTERN.match(p) or ".." in p for p in outputs):
        raise ToolError("Invalid output patterns.")
    timeout = run.get("timeoutMs", 60000)
    cap = run.get("maxOutputBytes", 16_000_000)
    if type(timeout) not in (int, float) or not LIMITS["min_timeout_ms"] <= timeout <= LIMITS["timeout_ms"]:
        raise ToolError("Invalid timeout.")
    if type(cap) not in (int, float) or not 1024 <= cap <= LIMITS["output_bytes"]:
        raise ToolError("Invalid output limit.")
    run_id = run.get("runId")
    if run_id is not None and (not isinstance(run_id, str) or not RUN_ID.match(run_id)):
        raise ToolError("Invalid run id.")
    extension, digest = run.get("extension"), run.get("extensionHash")
    if not isinstance(extension, str) or not EXTENSION_ID.match(extension) or not isinstance(digest, str) or not EXTENSION_HASH.match(digest):
        raise ToolError("Invalid external tool request: the extension and its version are required.")
    template = run.get("argTemplate") or []
    if not isinstance(template, list) or len(template) > 64 or any(not isinstance(a, str) or not a or len(a) > 200 or "\0" in a or
                                                                    sum(a.count(p) for p in PLACEHOLDERS) > 1 for a in template):
        raise ToolError("Invalid argument template.")
    return {"tool": tool_id, "args": list(args), "files": files, "outputs": list(outputs), "timeout": timeout / 1000.0,
            "cap": int(cap), "run_id": run_id, "extension": extension, "extension_hash": digest, "extension_key": extension + "@" + digest,
            "template": list(template), "extension_name": str(run.get("extensionName") or "")[:120], "tool_name": str(run.get("toolName") or tool_id)[:80]}


def _quote(a):
    return a if re.match(r"^[\w./:=+-]+$", a) else "'" + a.replace("'", "'\\''") + "'"


def command_line(path, args):
    """The exact command, quoted for display in the approval dialog."""
    return " ".join([_quote(path)] + [_quote(a) for a in args])


def resolved(path):
    """The program file an approval names: the chosen path with symlinks followed."""
    return os.path.realpath(path)


def outside_template(args, template, inputs, outputs):
    """The arguments of a run that its extension does not declare: not one of the run's input file
    names, not a plain name matching one of its output patterns, and not a template entry (literal,
    or with one {input} or {output} standing for such a name)."""
    inputs = set(inputs)

    def output(name):
        return bool(FILE_NAME.match(name)) and ".." not in name and any(fnmatch.fnmatchcase(name, p) for p in outputs)

    def fits(arg, entry):
        for placeholder in PLACEHOLDERS:
            i = entry.find(placeholder)
            if i >= 0:
                pre, post = entry[:i], entry[i + len(placeholder):]
                if len(arg) <= len(pre) + len(post) or not arg.startswith(pre) or not arg.endswith(post):
                    return False
                middle = arg[len(pre):len(arg) - len(post)]
                return middle in inputs if placeholder == "{input}" else output(middle)
        return arg == entry

    return [a for a in args if a not in inputs and not output(a) and not any(fits(a, e) for e in template)]


def approval_needed(store, req, path):
    """None when the run may start; else what to ask: {"title", "detail", "program", "command", "path"}:
    approve the program for this extension version, and/or this exact command (outside the template)."""
    real = resolved(path)
    outside = outside_template(req["args"], req["template"], [n for n, _ in req["files"]], req["outputs"])
    program = not store.approved(req["extension_key"], req["tool"], real)
    command = bool(outside) and not store.approved(req["extension_key"], req["tool"], real, req["args"])
    if not program and not command:
        return None
    who = req["extension_name"] or req["extension"]
    version = req["extension"] + ", " + req["extension_hash"][:19] + "\u2026"
    shown = command_line(path, req["args"])
    place = "It runs in a new temporary folder with the files the extension supplies."
    extra = " ".join(_quote(a) for a in outside)
    if program:
        declared = "its declared arguments (" + " ".join(req["template"]) + ") and its own file names" if req["template"] else "only its own input and output file names"
        detail = who + " (" + version + ") wants to run:\n\n" + shown + "\n\n" + place + " Allow this program for this version of the extension? Later runs that use " + \
            declared + " run without asking; any other argument, a new version or another program asks again."
        if outside:
            detail += "\n\nThis command also passes arguments the extension does not declare (" + extra + "); allowing it allows this exact command too."
    else:
        detail = who + " (" + version + ") wants to run " + req["tool_name"] + " with arguments it does not declare (" + extra + "):\n\n" + \
            shown + "\n\n" + place + " Allow this exact command?"
    return {"title": "Allow " + who + " to run " + req["tool_name"] + "?", "detail": detail, "program": program, "command": bool(outside), "path": real}


def record_approval(store, req, need):
    """After the user allowed what approval_needed asked for."""
    if need["program"]:
        store.approve(req["extension_key"], req["tool"], need["path"])
    if need["command"]:
        store.approve(req["extension_key"], req["tool"], need["path"], req["args"])


def minimal_env(work):
    env = {"PATH": "/usr/local/bin:/usr/bin:/bin", "TMPDIR": work, "LANG": os.environ.get("LANG", "C.UTF-8")}
    for key in ("HOME", "USER", "LOGNAME", "DISPLAY", "WAYLAND_DISPLAY", "XDG_RUNTIME_DIR", "SYSTEMROOT", "WINEPREFIX"):
        if os.environ.get(key):
            env[key] = os.environ[key]
    return env


def output_file(path, budget):
    """Only return a single-link regular file opened inside the run, within the actual byte budget."""
    try:
        fd = os.open(path, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK | os.O_CLOEXEC)
    except OSError:
        return None
    with os.fdopen(fd, "rb") as stream:
        info = os.fstat(fd)
        if not stat.S_ISREG(info.st_mode) or info.st_nlink != 1:
            return None
        if info.st_size <= budget:
            data = bytearray()
            while len(data) <= budget:
                chunk = stream.read(min(1024 * 1024, budget + 1 - len(data)))
                if not chunk:
                    return bytes(data)
                data.extend(chunk)
    raise OverflowError("The external tool output exceeds the remaining budget.")


class Runner:
    """Runs checked requests; cancel(run_id) stops one. Thread-safe."""

    def __init__(self):
        self.lock = threading.Lock()
        self.running = {}

    def cancel(self, run_id):
        with self.lock:
            job = self.running.get(run_id)
            if not job:
                return False
            job["cancelled"] = True
            process = job["process"]
        if process is not None:
            self._stop(process)
        return True

    @staticmethod
    def _stop(process):
        try:
            os.killpg(process.pid, signal.SIGTERM)
        except (OSError, AttributeError):
            try:
                process.terminate()
            except OSError:
                pass
        def later():
            time.sleep(KILL_GRACE)
            if process.poll() is None:
                try:
                    os.killpg(process.pid, signal.SIGKILL)
                except (OSError, AttributeError):
                    try:
                        process.kill()
                    except OSError:
                        pass
        threading.Thread(target=later, daemon=True).start()

    def reserve(self, req):
        job = {"process": None, "cancelled": False}
        key = req["run_id"] or "anon-%d" % id(job)
        with self.lock:
            if len(self.running) >= LIMITS["concurrent"] or key in self.running:
                raise ToolError("Too many external programs are running, or this run is already going.")
            self.running[key] = job
        return key, job

    def release(self, reservation):
        key, job = reservation
        with self.lock:
            if self.running.get(key) is job:
                del self.running[key]

    def run(self, path, req, reservation=None):
        reservation = reservation or self.reserve(req)
        key, job = reservation
        work = None
        try:
            work = tempfile.mkdtemp(prefix="atrium-run-")
            for name, data in req["files"]:
                with open(os.path.join(work, name), "xb") as out:
                    out.write(data)
            started = time.monotonic()
            with self.lock:
                if job["cancelled"]:
                    return {"exitCode": None, "signal": None, "timedOut": False, "cancelled": True, "truncated": False,
                            "durationMs": 0, "stdout": "", "stderr": "", "files": []}
                process = subprocess.Popen([path] + req["args"], cwd=work, env=minimal_env(work), stdin=subprocess.DEVNULL,
                                           stdout=subprocess.PIPE, stderr=subprocess.PIPE, shell=False, start_new_session=True, close_fds=True)
                job["process"] = process
            streams, truncated = {}, [False]

            def drain(name, pipe):
                kept = bytearray()
                for chunk in iter(lambda: pipe.read(65536), b""):
                    room = req["cap"] - len(kept)
                    if room > 0:
                        kept += chunk[:room]
                    if len(chunk) > max(room, 0):
                        truncated[0] = True
                streams[name] = bytes(kept)
            readers = [threading.Thread(target=drain, args=(n, p), daemon=True) for n, p in (("stdout", process.stdout), ("stderr", process.stderr))]
            for t in readers:
                t.start()
            timed_out = False
            try:
                process.wait(timeout=req["timeout"])
            except subprocess.TimeoutExpired:
                timed_out = True
                self._stop(process)
                process.wait()
            for t in readers:
                t.join(5)
            process.stdout.close(); process.stderr.close()
            files, budget = [], req["cap"]
            if req["outputs"]:
                with os.scandir(work) as directory:
                    entries = list(islice(directory, LIMITS["output_entries"] + 1))
                if len(entries) > LIMITS["output_entries"]:
                    truncated[0] = True
                    entries.clear()
                for entry in sorted(entries, key=lambda e: e.name):
                    if not entry.is_file(follow_symlinks=False) or not any(fnmatch.fnmatchcase(entry.name, p) for p in req["outputs"]):
                        continue
                    try:
                        data = output_file(entry.path, budget)
                    except OverflowError:
                        truncated[0] = True
                        continue
                    if data is not None:
                        budget -= len(data)
                        files.append({"name": entry.name, "data": base64.b64encode(data).decode("ascii")})
            code = process.returncode
            return {"exitCode": code if code is not None and code >= 0 else None,
                    "signal": -code if code is not None and code < 0 else None,
                    "timedOut": timed_out, "cancelled": job["cancelled"], "truncated": truncated[0],
                    "durationMs": int((time.monotonic() - started) * 1000),
                    "stdout": base64.b64encode(streams.get("stdout", b"")).decode("ascii"),
                    "stderr": base64.b64encode(streams.get("stderr", b"")).decode("ascii"), "files": files}
        finally:
            self.release(reservation)
            if work:
                shutil.rmtree(work, ignore_errors=True)
