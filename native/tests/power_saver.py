#!/usr/bin/env python3
"""The Linux host's Efficiency mode signal (native/linux/waffle.py PowerSaver), without GTK or a window.

As tests/core/power.cjs: the page hears lowPower only from the Power Saver power mode
(GPowerProfileMonitor's power-saver-enabled). Running on battery alone is not a signal, and a
GLib without the monitor reports nothing, so Automatic stays off.
"""
import importlib.util
import json
from pathlib import Path

NATIVE = Path(__file__).resolve().parents[1]


def load_linux():
    spec = importlib.util.spec_from_file_location("atrium_linux_host", NATIVE / "linux" / "waffle.py")
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


class Monitor:
    """GPowerProfileMonitor's surface: the property and its notify signal. on_battery is never read."""

    def __init__(self):
        self.saver, self.on_battery, self.handlers, self.next = False, False, {}, 1

    def get_power_saver_enabled(self):
        return self.saver

    def connect(self, signal, fn):
        assert signal == "notify::power-saver-enabled", signal
        self.next += 1
        self.handlers[self.next] = fn
        return self.next

    def disconnect(self, handler):
        del self.handlers[handler]

    def set(self, saver):
        self.saver = saver
        for fn in list(self.handlers.values()):
            fn(self, None)


def state_of(script):
    head = "globalThis.__atriumPowerState="
    assert script.startswith(head), script
    state = json.loads(script[len(head):script.index(";")])
    assert "new CustomEvent('atrium-power',{detail:" + json.dumps(state) + "})" in script, script
    return state


def check():
    host = load_linux()
    monitor, sent = Monitor(), []
    power = host.PowerSaver(monitor)
    assert power.state() == '{"lowPower": false}'
    power.start(sent.append)
    assert len(monitor.handlers) == 1
    power.push(force=True)
    assert [state_of(s) for s in sent] == [{"lowPower": False}], sent

    monitor.on_battery = True
    power.push()
    assert len(sent) == 1, "on battery with Power Saver off: nothing to tell, still not low power"

    monitor.set(True)
    assert state_of(sent[-1]) == {"lowPower": True}, "Power Saver on"
    monitor.set(True)
    assert len(sent) == 2, "no script when nothing changed"
    power.push(force=True)
    assert len(sent) == 3 and state_of(sent[-1]) == {"lowPower": True}, "a page load hears the state again"

    monitor.on_battery = False
    monitor.set(False)
    assert state_of(sent[-1]) == {"lowPower": False}, "Power Saver off"

    power.stop()
    assert not monitor.handlers
    monitor.set(True)
    assert len(sent) == 4, "a closed window hears nothing"

    # A GLib without GPowerProfileMonitor (before 2.70): nothing is reported, so Automatic stays off.
    none, quiet = host.PowerSaver(None), []
    none.start(quiet.append)
    none.push(force=True)
    assert quiet == [] and none.low_power() is False

    class Broken(Monitor):
        def get_power_saver_enabled(self):
            raise RuntimeError("the daemon went away")
    broken, told = host.PowerSaver(Broken()), []
    broken.start(told.append)
    broken.push(force=True)
    assert state_of(told[-1]) == {"lowPower": False}, "a monitor that cannot answer is not low power"
    print("PASS Linux power saver: Power Saver drives lowPower, battery alone does not, no monitor reports nothing")


if __name__ == "__main__":
    check()
