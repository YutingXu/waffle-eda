"""Capture the cold output actions on Chromium's real clock."""

import contextlib
import html
import json
from itertools import count
import os
from pathlib import Path
import signal
import subprocess
import sys
import time
import urllib.request

sys.path.insert(0, str(Path(__file__).resolve().parent / "ci"))
from chrome_cdp import checked_result, connect


def stopped(*_):
    raise SystemExit(124)


def cold_result(wire, url, deadline, wall):
    loads, contexts = set(), {}
    sequence = count(1)

    def observe(message):
        method = message.get("method")
        params = message.get("params", {})
        if method == "Page.lifecycleEvent" and params["name"] == "load":
            loads.add((params["frameId"], params["loaderId"]))
        elif method == "Runtime.executionContextCreated":
            context = params["context"]
            aux = context.get("auxData", {})
            if aux.get("isDefault") and context.get("uniqueId"):
                contexts[aux["frameId"]] = context["uniqueId"]
        elif method == "Runtime.executionContextsCleared":
            contexts.clear()
        elif method == "Inspector.targetCrashed":
            raise RuntimeError("Chromium's cold output target crashed")

    def call(method, **params):
        return checked_result(method, wire.raw_reply(method, params, next(sequence), on_event=observe))

    def startup_timeout():
        remaining = deadline - time.monotonic()
        if remaining <= 0:
            raise RuntimeError("The cold output page did not load in the requested context")
        wire.sock.settimeout(remaining)

    startup_timeout()
    call("Page.enable")
    call("Page.setLifecycleEventsEnabled", enabled=True)
    call("Runtime.enable")
    call("Inspector.enable")
    navigation = call("Page.navigate", url=url)
    if navigation.get("errorText") or navigation.get("isDownload") or not navigation.get("loaderId"):
        raise RuntimeError("Could not navigate to the cold output page: " + json.dumps(navigation))
    frame_id, loader = navigation["frameId"], navigation["loaderId"]
    while (frame_id, loader) not in loads or frame_id not in contexts:
        startup_timeout()
        observe(wire.read_message())

    def require_page():
        frame = call("Page.getFrameTree")["frameTree"]["frame"]
        if (frame["id"], frame["loaderId"], frame["url"]) != (frame_id, loader, url):
            raise RuntimeError("The cold output page navigated away: " + json.dumps(frame))

    require_page()
    # The page only defines its driver on arrival. Arm it once in this exact renderer
    # context so a renderer swap or reload cannot start another copy of the actions.
    wire.sock.settimeout(wall)
    reply = call("Runtime.evaluate", expression="runCold()", uniqueContextId=contexts[frame_id],
                 awaitPromise=True, returnByValue=True, timeout=wall * 1000)
    if "exceptionDetails" in reply:
        raise RuntimeError("Cold output action driver failed: " + json.dumps(reply["exceptionDetails"]))
    result = reply["result"].get("value")
    if not isinstance(result, str):
        raise RuntimeError("The cold output action driver did not return a result")
    require_page()
    return result


def main():
    chrome, gpu, profile, page, wall = sys.argv[1:]
    wall = float(wall)
    signal.signal(signal.SIGTERM, stopped)
    url = Path(page).resolve().as_uri()
    port_file = Path(profile, "DevToolsActivePort")
    proc = subprocess.Popen([chrome, "--headless=new", gpu, "--no-first-run",
                             "--allow-file-access-from-files", "--enable-logging=stderr",
                             "--remote-debugging-port=0", f"--user-data-dir={profile}",
                             "--window-size=1440,900", "about:blank"], start_new_session=True)
    try:
        end = time.monotonic() + min(wall, 12)
        while time.monotonic() < end and proc.poll() is None:
            try:
                port = int(port_file.read_text().splitlines()[0])
                with urllib.request.urlopen(f"http://127.0.0.1:{port}/json/list", timeout=1) as endpoint:
                    tab = next((t for t in json.load(endpoint) if t["type"] == "page" and t["url"] == "about:blank"), None)
                if tab:
                    break
            except (OSError, ValueError, IndexError):
                pass
            time.sleep(0.05)
        else:
            sys.exit("Chromium did not open the cold output test page")
        wire = connect(tab["webSocketDebuggerUrl"], timeout=min(wall, 12))
        with wire.sock:
            result = cold_result(wire, url, end, wall)
            wire.sock.settimeout(2)
            with contextlib.suppress(OSError, EOFError):
                checked_result("Browser.close", wire.raw_reply("Browser.close", {}, 0))
        print('<pre id="CLICK">'+html.escape(result)+'</pre>')
    finally:
        with contextlib.suppress(ProcessLookupError):
            os.killpg(proc.pid, signal.SIGKILL)
        proc.wait()


if __name__ == "__main__":
    main()
