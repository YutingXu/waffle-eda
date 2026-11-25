#!/usr/bin/env python3
"""Same-network sessions: the LAN relays of the Linux app (native/linux/lan_relay.py) and, on macOS,
of the macOS app (native/macos/LanRelay.swift, compiled here with a small driver), on loopback:
  * nothing listens before start or after stop;
  * before joining, {"t": "info"} gives only the session's public facts (salt, display name, host id);
  * only the shared room can be joined, with its token; messages and signalling reach the others;
  * a peer that leaves is announced; the owner may rejoin; the Linux relay binds only loopback and
    the local-network addresses it was given, and finds only private addresses;
  * mDNS output from avahi-browse is parsed to sessions (name, address, port), nothing else.
Run: python3 native/tests/lan_relay.py
"""
import asyncio
import base64
import hashlib
import json
import os
from pathlib import Path
import platform
import shutil
import socket
import struct
import subprocess
import sys
import tempfile

ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT / "native" / "linux"))
import lan_relay as L  # noqa: E402


class Client:
    @classmethod
    async def open(cls, port):
        c = cls()
        c.reader, c.writer = await asyncio.open_connection("127.0.0.1", port)
        key = base64.b64encode(os.urandom(16)).decode()
        c.writer.write(("GET / HTTP/1.1\r\nHost: x\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Key: %s\r\nSec-WebSocket-Version: 13\r\n\r\n" % key).encode())
        head = await asyncio.wait_for(c.reader.readuntil(b"\r\n\r\n"), 5)
        assert b" 101 " in head.split(b"\r\n")[0], head
        return c

    async def send(self, obj):
        data = json.dumps(obj).encode()
        n = len(data)
        head = bytes([0x81]) + (bytes([0x80 | n]) if n < 126 else bytes([0x80 | 126]) + struct.pack("!H", n) if n < 65536 else bytes([0x80 | 127]) + struct.pack("!Q", n))
        mask = os.urandom(4)
        self.writer.write(head + mask + bytes(b ^ mask[i % 4] for i, b in enumerate(data)))
        await self.writer.drain()

    async def recv(self, timeout=3.0):
        async def one():
            h = await self.reader.readexactly(2)
            n = h[1] & 0x7F
            if n == 126:
                n = struct.unpack("!H", await self.reader.readexactly(2))[0]
            elif n == 127:
                n = struct.unpack("!Q", await self.reader.readexactly(8))[0]
            return h[0] & 0x0F, await self.reader.readexactly(n)
        while True:
            op, data = await asyncio.wait_for(one(), timeout)
            if op == 0x1:
                return json.loads(data)
            if op == 0x8:
                return {"t": "closed"}

    async def next(self, kind, timeout=3.0):
        while True:
            m = await self.recv(timeout)
            if m.get("t") in (kind, "closed", "error") or kind is None:
                return m

    def close(self):
        self.writer.close()


def room_for(secret):
    auth = hashlib.sha256(secret).digest()
    return hashlib.sha256(auth).hexdigest(), auth.hex()


async def protocol(port, label, room, salt):
    info = await Client.open(port)
    await info.send({"t": "info"})
    facts = await info.next("info")
    assert facts["salt"] == salt and facts["name"] == "Board review" and facts["v"] == 2, (label, facts)
    assert set(facts) <= {"t", "v", "salt", "name", "host"}, (label, "info gives only public facts", facts)
    _, auth = room_for(b"lan")
    other_room, other_auth = room_for(b"another")
    await info.send({"t": "join", "room": other_room, "auth": other_auth, "v": 2})
    assert "not shared here" in (await info.next("error"))["e"], (label, "only the shared room")
    stranger = await Client.open(port)
    await stranger.send({"t": "join", "room": room, "auth": "00" * 32, "v": 2})
    assert (await stranger.next("error"))["t"] == "error", (label, "a wrong token is refused")
    host = await Client.open(port)
    await host.send({"t": "join", "room": room, "auth": auth, "v": 2, "own": "owner-token-0123456789"})
    hj = await host.next("joined")
    assert hj["owner"] is True and hj["peers"] == [] and hj["ice"] == [], (label, hj)
    guest = await Client.open(port)
    await guest.send({"t": "info"})
    await guest.next("info")
    await guest.send({"t": "join", "room": room, "auth": auth, "v": 2})
    gj = await guest.next("joined")
    assert gj["peers"] == [hj["id"]] and gj["owner"] is False, (label, gj)
    assert (await host.next("peer"))["id"] == gj["id"]
    await guest.send({"t": "m", "d": "ciphertext-1"})
    m = await host.next("m")
    assert m["d"] == "ciphertext-1" and m["from"] == gj["id"], (label, m)
    await host.send({"t": "m", "d": "to-guest", "to": [gj["id"]]})
    assert (await guest.next("m"))["d"] == "to-guest"
    await host.send({"t": "sig", "to": gj["id"], "d": "offer"})
    s = await guest.next("sig")
    assert s["from"] == hj["id"] and s["d"] == "offer", (label, s)
    guest.close()
    left = await host.next("peer")
    assert left["id"] == gj["id"] and left["joined"] is False, (label, "a guest who leaves is announced")
    for c in (info, stranger, host):
        c.close()


def listening(port):
    with socket.socket() as s:
        s.settimeout(0.5)
        return s.connect_ex(("127.0.0.1", port)) == 0


async def linux_relay(room, salt):
    lan = L.LanRelay(addresses=[], advertise=False)   # loopback only in the test
    assert not lan.running
    started = lan.start(room, salt, "Board  review\n")
    port = started["port"]
    assert started["name"] == "Board review" and started["advertised"] is False
    assert listening(port)
    bound = sorted({s.getsockname()[0] for s in lan.server.sockets})
    assert bound == ["127.0.0.1"], bound
    await protocol(port, "linux", room, salt)
    lan.stop()
    await asyncio.sleep(0.2)
    assert not listening(port), "nothing listens after stop"
    # Addresses: private local networks only.
    sample = json.dumps([
        {"ifname": "lo", "flags": ["LOOPBACK", "UP"], "addr_info": [{"local": "127.0.0.1"}]},
        {"ifname": "wlp2s0", "flags": ["UP"], "addr_info": [{"local": "192.168.1.20"}, {"local": "fe80::1"}, {"local": "fd12:3456::7"}]},
        {"ifname": "eth0", "flags": ["UP"], "addr_info": [{"local": "203.0.113.9"}, {"local": "10.1.2.3"}]},
        {"ifname": "tailscale0", "flags": ["UP"], "addr_info": [{"local": "100.101.102.103"}]}])
    with tempfile.TemporaryDirectory() as sysfs:
        # /sys/class/net: physical interfaces have a device link, virtual ones (docker0, tun0, wg0,
        # veth*, br-*, ...) do not; eth1 here is a USB Ethernet adapter, docker0 is "made physical" to
        # show the name rule still applies.
        for name, device in (("lo", False), ("wlp2s0", True), ("eth0", True), ("eth1", True), ("tailscale0", False),
                             ("docker0", True), ("tun0", False), ("wg0", False), ("veth12ab", False), ("br-5f0e", False),
                             ("virbr0", False), ("enp0s31f6", False)):
            os.makedirs(os.path.join(sysfs, name, "device") if device else os.path.join(sysfs, name))
        none = "[]"
        got = L.lan_addresses(sample, none, sysfs)
        assert got == ["192.168.1.20", "10.1.2.3", "fd12:3456::7"], ("private, physical, IPv4 first", got)
        # The review probe: Docker, OpenVPN and WireGuard addresses are private too, but not this network.
        links = json.dumps([
            {"ifname": "lo", "flags": ["LOOPBACK", "UP"], "link_type": "loopback", "addr_info": [{"local": "127.0.0.1"}]},
            {"ifname": "docker0", "flags": ["BROADCAST", "UP"], "link_type": "ether", "addr_info": [{"local": "172.17.0.1"}]},
            {"ifname": "wlp2s0", "flags": ["BROADCAST", "UP"], "link_type": "ether", "addr_info": [{"local": "192.168.1.20"}]},
            {"ifname": "tun0", "flags": ["POINTOPOINT", "UP"], "link_type": "none", "addr_info": [{"local": "10.8.0.6"}]},
            {"ifname": "wg0", "flags": ["POINTOPOINT", "NOARP", "UP"], "link_type": "none", "addr_info": [{"local": "10.66.0.2"}]},
            {"ifname": "veth12ab", "flags": ["BROADCAST", "UP"], "link_type": "ether", "addr_info": [{"local": "172.18.0.1"}]},
            {"ifname": "br-5f0e", "flags": ["BROADCAST", "UP"], "link_type": "ether", "addr_info": [{"local": "172.19.0.1"}]},
            {"ifname": "virbr0", "flags": ["BROADCAST", "UP"], "link_type": "ether", "addr_info": [{"local": "192.168.122.1"}]},
            {"ifname": "enp0s31f6", "flags": ["BROADCAST", "UP"], "link_type": "ether", "addr_info": [{"local": "192.168.50.2"}]},   # no device: virtual
            {"ifname": "eth1", "flags": ["BROADCAST", "UP"], "link_type": "ether", "addr_info": [{"local": "10.0.0.7"}]}])
        assert L.lan_addresses(links, none, sysfs) == ["192.168.1.20", "10.0.0.7"], L.lan_addresses(links, none, sysfs)
        # The default route's interface comes first and is the invitation's address (primary).
        routes = json.dumps([{"dst": "default", "gateway": "10.8.0.1", "dev": "tun0", "metric": 50},
                             {"dst": "default", "gateway": "10.0.0.1", "dev": "eth1", "metric": 100},
                             {"dst": "default", "gateway": "192.168.1.1", "dev": "wlp2s0", "metric": 600}])
        nets = L.lan_networks(links, routes, sysfs)
        assert nets == {"addresses": ["10.0.0.7", "192.168.1.20"], "primary": "10.0.0.7"}, nets
        nets = L.lan_networks(links, none, sysfs)
        assert nets["primary"] is None and nets["addresses"][0] == "192.168.1.20", nets
        # Only virtual interfaces: no local network (the relay then says so instead of binding docker0).
        only_docker = json.dumps([json.loads(links)[1], json.loads(links)[3]])
        assert L.lan_networks(only_docker, routes, sysfs) == {"addresses": [], "primary": None}
    browse = "\n".join([
        "+;wlp2s0;IPv4;Board review;_waffle._tcp;local",
        "=;wlp2s0;IPv4;Board\\032review;_waffle._tcp;local;alice.local;192.168.1.20;48765;\"v=2\"",
        "=;wlp2s0;IPv6;Board\\032review;_waffle._tcp;local;alice.local;fe80::1;48765;\"v=2\"",
        "=;wlp2s0;IPv4;Printer;_ipp._tcp;local;p.local;192.168.1.5;631;",
        "=;wlp2s0;IPv4;Board\\032review;_waffle._tcp;local;alice.local;192.168.1.20;48765;\"v=2\""])
    assert L.parse_browse(browse) == [{"name": "Board review", "address": "192.168.1.20", "port": 48765}], L.parse_browse(browse)


DRIVER = r'''
import Foundation
let a = CommandLine.arguments
let relay = LanRelay()
relay.start(room: a[1], salt: a[2], name: "Board  review", advertise: false) { result in
    switch result {
    case .success(let info): print("PORT \(info["port"]!) \(info["name"]!)"); fflush(stdout)
    case .failure(let e): print("ERROR \(e)"); fflush(stdout); exit(1)
    }
}
DispatchQueue.global().async { _ = readLine(); relay.stop(); print("STOPPED"); fflush(stdout); sleep(1); exit(0) }
RunLoop.main.run()
'''


async def macos_relay(room, salt):
    if platform.system() != "Darwin" or not shutil.which("xcrun"):
        return "skipped (not macOS)"
    with tempfile.TemporaryDirectory() as tmp:
        driver, binary = Path(tmp) / "main.swift", Path(tmp) / "lan-relay"
        driver.write_text(DRIVER)
        subprocess.run(["xcrun", "swiftc", "-swift-version", "5", "-module-cache-path", str(Path(tmp) / "cache"),
                        str(ROOT / "native" / "macos" / "LanRelay.swift"), str(driver), "-o", str(binary)], check=True)
        p = subprocess.Popen([str(binary), room, salt], stdin=subprocess.PIPE, stdout=subprocess.PIPE, text=True)
        try:
            line = p.stdout.readline().split()
            assert line[0] == "PORT", line
            port = int(line[1])
            assert " ".join(line[2:]) == "Board review", line
            await protocol(port, "macos", room, salt)
            p.stdin.write("\n"); p.stdin.flush()
            assert p.stdout.readline().strip() == "STOPPED"
            await asyncio.sleep(0.3)
            assert not listening(port), "nothing listens after stop (macOS)"
        finally:
            p.kill()
        await macos_fallback(room, salt, tmp)
    return "ok, and the free-port fallback with advertising on"


# The default port is taken (another window or app already shares on this network): a second relay that
# advertises (the app's default) must fall back to a free port. The fallback runs in the listener's state
# handler, on the relay's queue; it once did queue.sync onto that same queue and crashed (SIGTRAP).
FALLBACK_DRIVER = r'''
import Foundation
let a = CommandLine.arguments
let first = LanRelay(), second = LanRelay()
first.start(room: a[1], salt: a[2], name: "First", advertise: false) { r in
    guard case .success(let one) = r else { print("ERROR first \(r)"); fflush(stdout); exit(1) }
    second.start(room: a[1], salt: a[2], name: "Second  window", advertise: true) { r2 in
        switch r2 {
        case .success(let two): print("PORTS \(one["port"]!) \(two["port"]!) \(two["advertised"]!) \(two["name"]!)"); fflush(stdout)
        case .failure(let e): print("ERROR second \(e)"); fflush(stdout); exit(1)
        }
        DispatchQueue.global().async { _ = readLine(); first.stop(); second.stop(); print("STOPPED"); fflush(stdout); exit(0) }
    }
}
DispatchQueue.global().asyncAfter(deadline: .now() + 15) { print("TIMEOUT"); fflush(stdout); exit(2) }
RunLoop.main.run()
'''


async def macos_fallback(room, salt, tmp):
    (Path(tmp) / "fallback").mkdir()
    driver, binary = Path(tmp) / "fallback" / "main.swift", Path(tmp) / "lan-fallback"   # top-level code: main.swift
    driver.write_text(FALLBACK_DRIVER)
    subprocess.run(["xcrun", "swiftc", "-swift-version", "5", "-module-cache-path", str(Path(tmp) / "cache"),
                    str(ROOT / "native" / "macos" / "LanRelay.swift"), str(driver), "-o", str(binary)], check=True)
    p = subprocess.Popen([str(binary), room, salt], stdin=subprocess.PIPE, stdout=subprocess.PIPE, text=True)
    try:
        line = p.stdout.readline().split()
        assert line and line[0] == "PORTS", ("the second relay falls back to a free port with advertising on", line, p.poll())
        one, two = int(line[1]), int(line[2])
        assert two not in (0, one, L.PORT), ("a different, free port", line)
        assert line[3] == "true" and " ".join(line[4:]) == "Second window", line
        c = await Client.open(two)
        await c.send({"t": "info"})
        facts = await c.next("info")
        assert facts["salt"] == salt and facts["name"] == "Second window", facts
        c.close()
        p.stdin.write("\n"); p.stdin.flush()
        assert p.stdout.readline().strip() == "STOPPED"
    finally:
        p.kill()


async def main():
    room, _ = room_for(b"lan")
    salt = "S" * 22
    await linux_relay(room, salt)
    mac = await macos_relay(room, salt)
    print("lan_relay: ok (Linux relay on loopback: info, one room, tokens, messages, signalling, leaving, stop, private addresses, avahi parsing; macOS LanRelay.swift: %s)" % mac)


if __name__ == "__main__":
    asyncio.run(main())
