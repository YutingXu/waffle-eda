"""Verify the installed GTK Open and native file drop reject pre-release formats."""
import ctypes
import json
import os
import traceback

import package
from package import GLib, Probe, wait_for


class LegacyOpen(Probe):
    def opened_source(self, file, name):
        note = self.host.PRE_RELEASE_MESSAGE
        def refused():
            for window in self.on_gtk(self.editors):
                if self.js(window,"return window.__lastNativeOpenError===" + json.dumps(note) + " && !AtriumHost.folderGitGrant;"):
                    return window
            return None
        return wait_for("exact re-import refusal without a file grant",refused)

    def run(self):
        window = None
        try:
            window = wait_for("packaged WebKitGTK window",lambda: self.on_gtk(lambda:next(
                (w for w in self.editors() if w.get_child().get_uri() and not w.get_child().is_loading()),None)))
            wait_for("editor ready",lambda:self.js(window,"return !!globalThis.AtriumNavHost;"))
            self.js(window,"""
                AtriumStartPage.close();
                const receive=window.__atriumReceive;
                window.__atriumReceive=(id,value,error)=>{
                  if (error) window.__lastNativeOpenError=error;
                  return receive(id,value,error);
                };
                return true;
                """)
            root = self.work / "retired"
            root.mkdir()
            for ext in ("waffle","atrium"):
                source = root / ("Retired." + ext)
                journal = source.with_name(source.name+".journal")
                draft = source.with_name(source.name+"~")
                source.write_bytes(b'{"format":"atrium","version":1,"documents":[],"library":[]}')
                journal.write_bytes(b"ATRIUM-JOURNAL 1\nprivate saved edit")
                draft.write_bytes(b"private draft")
                originals = {p:p.read_bytes() for p in (source,journal,draft)}
                # Watch opens at the companion inodes, not our later checksum reads.
                libc = ctypes.CDLL(None,use_errno=True)
                flags = os.O_NONBLOCK | os.O_CLOEXEC
                watch = libc.inotify_init1(flags)
                assert watch >= 0
                try:
                    for file in (journal,draft):
                        assert libc.inotify_add_watch(watch,os.fsencode(file),0x00000020) >= 0
                    for route in ("open","drop"):
                        self.js(window,"window.__lastNativeOpenError=null; for (const d of document.querySelectorAll('dialog[open]')) d.close(); return true;")
                        if route == "open" and ext == "atrium":
                            # GTK filters exclude this suffix. Simulate the OS-supplied direct open
                            # with the host's public application route; the real drop covers GDK.
                            self.begin(window,"AtriumHost.open()")
                            dialog = self.dialog(window,package.Gtk.FileChooserDialog)
                            def accept_old():
                                dialog.remove_filter(dialog.get_filter())
                                assert dialog.set_filename(str(source))
                            self.on_gtk(accept_old)
                            wait_for("direct selection after filter bypass", lambda:self.on_gtk(lambda: dialog.get_filename() == str(source)))
                            self.on_gtk(lambda:dialog.response(package.Gtk.ResponseType.ACCEPT))
                            assert self.result(window)["error"] == self.host.PRE_RELEASE_MESSAGE
                        else:
                            assert getattr(self,route)(window,source,"retired") == window
                        assert not (root / ".waffle").exists()
                    try:
                        events = os.read(watch,4096)
                    except BlockingIOError:
                        events = b""
                    assert not events,"the opener read a pre-release journal or private draft"
                finally:
                    os.close(watch)
                assert all(p.read_bytes()==data for p,data in originals.items())
                print("PASS installed GTK Open and drop refuse ."+ext+" and never open its journal or private draft",flush=True)
            self.ok = True
        except Exception:
            traceback.print_exc()
        finally:
            GLib.idle_add(self.dismiss_dialogs)


if __name__=="__main__":
    package.Probe=LegacyOpen
    raise SystemExit(package.main())
