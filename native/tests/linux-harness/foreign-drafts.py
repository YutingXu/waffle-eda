#!/usr/bin/env python3
"""Exercise the installed GTK editor's unsaved foreign import through two killed processes.

Run under Xvfb as an ordinary user with the release dependencies and xdotool installed:
    xvfb-run -a python3 native/tests/linux-harness/foreign-drafts.py tests/fixtures/import/review/proto/p.kicad_pcb
The selected file is copied into a disposable private profile before the editor sees it.
"""
import argparse
import importlib.util
import os
from pathlib import Path
import shutil
import signal
import subprocess
import sys
import tempfile
import threading
import traceback

from package import GLib, Gtk, Probe, wait_for, xdo


class ForeignDraftProbe(Probe):
    def __init__(self, work, host, fixture, phase):
        super().__init__(work, host)
        self.fixture = fixture
        self.selected = work / "selection" / "Ordinary.kicad_pcb"
        self.phase = phase

    def private_result(self, window, expression):
        self.begin(window, expression)
        result = self.result(window, "private recovery checkpoint")
        if "error" in result:
            raise RuntimeError(result["error"])
        return result["value"]

    def review(self, window):
        self.on_gtk(window.close)
        wait_for("per-project native Quit review", lambda: self.js(window,
            "return document.querySelector('.foreign-import-close p')?.textContent==='Not saved yet (imported from KiCad)'"))

    def first_save(self, window):
        panel = self.dialog(window, Gtk.MessageDialog)
        assert self.on_gtk(lambda: panel.get_property("secondary-text")) == (
            "This design was imported from KiCad. Saving as a Waffle project keeps everything you add "
            "and makes saves instant and Git-friendly. Your original KiCad files stay untouched."
        )
        assert self.on_gtk(lambda: panel.get_response_for_widget(panel.get_default_widget())) == Gtk.ResponseType.ACCEPT
        confirm = self.on_gtk(lambda: panel.get_widget_for_response(Gtk.ResponseType.ACCEPT).get_label())
        assert confirm.replace("_", "") == "Save as Waffle Project…"
        return panel

    def run(self):
        try:
            window = wait_for("installed GTK editor", lambda: self.on_gtk(lambda: next(
                (w for w in self.editors() if w.get_child().get_uri() and not w.get_child().is_loading()), None)))
            wait_for("editor ready", lambda: self.js(window, "return !!globalThis.AtriumNavHost"))
            if self.phase == "open":
                wait_for("accepted native import", lambda: self.js(window, "return !!AtriumNavHost.importSession()"))
                assert self.private_result(window, """(async () => !AtriumNavHost.folderProject() && AtriumNavHost.isDirty() &&
                    (await AtriumFolderDrafts.storage.list(AtriumFolderDrafts.foreignScope)).length===1)()""")
                self.click_page(window, "document.querySelector('.import-save-hint button')")
                panel = self.first_save(window)
                self.focus(panel)
                xdo("key", "--clearmodifiers", "Escape")
                wait_for("Escape returns focus to the imported Save link", lambda: not self.on_gtk(panel.get_visible)
                         and self.js(window, "return document.activeElement?.matches('.import-save-link') && AtriumNavHost.isDirty()"))
            elif self.phase == "empty":
                assert self.private_result(window, """(async () => {
                    const s=await AtriumLazy.need('AtriumFolderDrafts');return (await s.storage.list(s.foreignScope)).length===0;
                })()""")
            else:
                wait_for("private restore offer", lambda: self.js(window,
                    "return !!document.querySelector('.foreign-import-recovery[open] [data-choice=restore]')"))
                self.js(window, "document.querySelector('.foreign-import-recovery [data-choice=restore]').click();return true")
                wait_for("restored imported owner", lambda: self.js(window, "return !!AtriumNavHost.importSession()"))
                assert self.private_result(window, """(async () => {
                    const f=AtriumImportReports.retained()[0].provenance.files[0];
                    return !!f.bytes && await AtriumImportSidecars.sha(f.bytes)===f.sha256;
                })()""")
                if self.phase == "edit":
                    self.js(window, """const h=AtriumNavHost;
                        h.edit(()=>h.project().documents[0].name='Verified GTK edit');return true""")
                    wait_for("authored edit reached private storage", lambda: self.private_result(window, """(async () => {
                        const s=AtriumFolderDrafts, rows=await s.storage.list(s.foreignScope);
                        return rows[0].rows.some(r=>r.id.startsWith('Verified GTK edit.'));
                    })()"""))
                else:
                    assert self.js(window, "return AtriumNavHost.project().documents.some(d=>d.name==='Verified GTK edit')")
                    self.review(window)
                    if self.phase == "keep":
                        self.js(window, "document.querySelector('.foreign-import-close [data-choice=save]').click();return true")
                        dialog = self.first_save(window)
                        self.click(dialog, lambda: dialog.get_widget_for_response(Gtk.ResponseType.CANCEL))
                        wait_for("cancelled native first Save", lambda: self.on_gtk(lambda: not dialog.get_visible())
                                 and self.js(window, "return AtriumNavHost.isDirty()"))
                        self.review(window)
                    self.js(window, "document.querySelector('.foreign-import-close [data-choice=" +
                            self.phase + "]').click();return true")
            assert self.selected.read_bytes() == self.fixture.read_bytes()
            assert list(self.selected.parent.iterdir()) == [self.selected], "Open or recovery created a source sibling"
            print("PASS GTK foreign import", self.phase, flush=True)
            self.ok = True
            if self.phase in ("open", "edit"):
                os.kill(os.getpid(), signal.SIGKILL)
            if self.phase == "empty":
                GLib.idle_add(Gtk.main_quit)
        except Exception:
            traceback.print_exc()
            GLib.idle_add(Gtk.main_quit)


def phase(work, fixture, choice):
    launcher = shutil.which("waffle-eda") or shutil.which("waffle")
    if os.getuid() == 0 or not os.environ.get("DISPLAY") or not launcher:
        raise SystemExit("Use the installed Waffle package and an isolated X display as an ordinary user.")
    source = Path(launcher).resolve(strict=True)
    spec = importlib.util.spec_from_file_location("installed_waffle", source)
    host = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(host)
    for name in ("HOME", "XDG_DATA_HOME", "XDG_CONFIG_HOME", "XDG_CACHE_HOME"):
        private = work / name.lower()
        private.mkdir(exist_ok=True)
        os.environ[name] = str(private)
    probe = ForeignDraftProbe(work, host, fixture, choice)
    if choice == "open":
        probe.selected.parent.mkdir()
        shutil.copyfile(fixture, probe.selected)
    sys.excepthook = probe.callback_failed
    driver = threading.Thread(target=probe.run, daemon=True)
    GLib.idle_add(lambda: driver.start() or False)
    sys.argv = [launcher] + ([str(probe.selected)] if choice == "open" else [])
    status = host.main()
    driver.join(5)
    return 0 if status == 0 and probe.ok and not probe.callback_errors else 1


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("fixture", type=Path)
    parser.add_argument("--phase", choices=("open", "edit", "keep", "discard", "empty"))
    parser.add_argument("--profile", type=Path)
    args = parser.parse_args()
    fixture = args.fixture.resolve(strict=True)
    if args.phase:
        if not args.profile:
            parser.error("An isolated profile is required for a child phase.")
        return phase(args.profile.resolve(strict=True), fixture, args.phase)
    with tempfile.TemporaryDirectory(prefix="waffle-unsaved-import-") as work:
        for choice in ("open", "edit", "keep", "discard", "empty"):
            child = subprocess.run([sys.executable, "-B", __file__, str(fixture), "--phase", choice,
                                    "--profile", work], timeout=90)
            expected = -signal.SIGKILL if choice in ("open", "edit") else 0
            if child.returncode != expected:
                raise SystemExit("Unexpected exit in " + choice + ": " + str(child.returncode))
    return 0


if __name__ == "__main__":
    sys.exit(main())
