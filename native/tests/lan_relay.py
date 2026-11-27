#!/usr/bin/env python3
"""Same-network sessions: one conformance suite for every host's LAN listener, on loopback.

The listeners are the Linux app's (native/linux/lan_relay.py, which runs collab/relay/waffle_relay.py
in lan mode), the macOS app's (native/macos/LanRelay.swift, compiled here with a small driver) and the
Windows app's (native/windows/src/Core/LanRelay.cs, through the Windows test program). They must
speak one protocol: the standalone relay's (waffle_relay.py, docs/collaboration.md) in lan mode, with
its limits. The suite checks, against each target:
  * the four bridge replies (lanStart, lanHost, lanStop; lanBrowse is checked per host below);
  * info: only the session's public facts, once, before the join;
  * joining: only the shared room, only with its token, nothing else first; the joined shape;
  * peer notices, `m` to everyone or to named peers and `sig` to one peer, never echoed;
  * oversize, unmasked and binary frames close the connection; fragments, ping;
  * capacity (16) with the owner allowed past it; the owner may rejoin and stays the owner;
  * limits: join timeout, idle timeout, joins per address and per room, connections per address and
    overall, the rate limit that slows a sender (never cuts it off), a stalled reader is cut off,
    a quiet room is never closed (lan_room_idle is off); the keepalive {"t": "p"} is answered to its
    sender only; no HTTP pages; nothing listens after stop.
The relay-only checks (TURN, private mode, /healthz, read and queue budgets) are in
tests/project/collab-relay.py, whose WebSocket client this suite reuses.

Driver contract (every target is a command; the suite appends ROOM and SALT to it):
  * listen on loopback only, with the session name "Board  review" (the listener cleans it);
  * environment WAFFLE_LAN_LIMITS: optional JSON {name: number} that overrides the listener's limits,
    with waffle_relay.Limits names (idle, join_timeout, rate_messages, ...);
  * print `PORT <port> <name>`, then `REPLY <JSON>` with lanStart's reply;
  * for each stdin line `host <id>`: call lanHost and print `REPLY <JSON>`; any other line: call
    lanStop, print `REPLY <JSON>` with its reply, then `STOPPED`, and exit.

Run: python3 native/tests/lan_relay.py [--target linux|macos|windows|NAME=COMMAND ...] [--only CHECK]
Without --target: linux, macos on a Mac, windows when DOTNET or dotnet is found.
`python3 native/tests/lan_relay.py --driver` is the Linux listener's driver.
"""
import argparse
import asyncio
import base64
import hashlib
import importlib.util
import json
import os
from pathlib import Path
import platform
import re
import shlex
import shutil
import socket
import struct
import subprocess
import sys
import tempfile
import time

ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT / "native" / "linux"))
import lan_relay as L  # noqa: E402
R = L.R   # the reference relay (collab/relay/waffle_relay.py)

# The relay test's WebSocket client (handshake check, masked frames, close codes).
_spec = importlib.util.spec_from_file_location("collab_relay_test", ROOT / "tests" / "project" / "collab-relay.py")
CR = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(CR)
room_for, http = CR.room_for, CR.http

NAME = "Board  review"
CID = re.compile(r"c[0-9a-f]{16}\Z")


class Client(CR.Client):
    """collab-relay.py's client; EOF reads as a close, and errors end a wait for another kind."""

    @classmethod
    async def raw(cls, port, rcvbuf=None):
        """A TCP connection, not yet upgraded (rcvbuf: a small receive buffer for a peer that stalls)."""
        sock = socket.socket()
        if rcvbuf:
            sock.setsockopt(socket.SOL_SOCKET, socket.SO_RCVBUF, rcvbuf)
        sock.setblocking(False)
        await asyncio.get_running_loop().sock_connect(sock, ("127.0.0.1", port))
        reader, writer = await asyncio.open_connection(sock=sock)
        return cls(reader, writer)

    async def upgrade(self):
        """The HTTP response head to an upgrade request: b"" when the listener closed instead."""
        key = base64.b64encode(os.urandom(16)).decode()
        self.writer.write(("GET / HTTP/1.1\r\nHost: x\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n"
                           "Sec-WebSocket-Key: %s\r\nSec-WebSocket-Version: 13\r\n\r\n" % key).encode())
        try:
            head = await asyncio.wait_for(self.reader.readuntil(b"\r\n\r\n"), 3)
        except (asyncio.IncompleteReadError, ConnectionError):
            return b""
        if head.startswith(b"HTTP/1.1 101"):
            want = base64.b64encode(hashlib.sha1(key.encode() + R.GUID).digest())
            assert want in head, ("Sec-WebSocket-Accept", head)
        return head

    @classmethod
    async def open(cls, port, rcvbuf=None):
        c = await cls.raw(port, rcvbuf)
        head = await c.upgrade()
        assert head.startswith(b"HTTP/1.1 101"), ("upgraded", head)
        return c

    async def recv(self, timeout=3.0):
        try:
            return await super().recv(timeout)
        except (asyncio.IncompleteReadError, ConnectionError):
            return {"closed": "eof"}

    async def expect(self, kind, timeout=3.0):
        """The next message of this kind, skipping others; an error or a close ends the wait."""
        while True:
            m = await self.recv(timeout)
            if "closed" in m or m.get("t") in (kind, "error"):
                return m

    async def frames(self, timeout=3.0):
        """The next raw frame: (opcode, payload)."""
        head = await asyncio.wait_for(self.reader.readexactly(2), timeout)
        n = head[1] & 0x7F
        if n == 126:
            n = struct.unpack("!H", await self.reader.readexactly(2))[0]
        elif n == 127:
            n = struct.unpack("!Q", await self.reader.readexactly(8))[0]
        return head[0] & 0x0F, await self.reader.readexactly(n)

    async def join(self, room, auth, **extra):
        await self.send({"t": "join", "room": room, "auth": auth, "v": 2, **extra})
        return await self.expect("joined")

    def close(self):
        try:
            self.writer.close()
        except Exception:
            pass


def closed_code(m):
    return m.get("closed") if isinstance(m, dict) else None


def listening(port):
    with socket.socket() as s:
        s.settimeout(0.5)
        return s.connect_ex(("127.0.0.1", port)) == 0


# ---- targets -------------------------------------------------------------------------------------------

class Driver:
    """One listener process following the driver contract."""

    def __init__(self, argv, room, salt, limits=None):
        env = dict(os.environ)
        env.pop("WAFFLE_LAN_LIMITS", None)
        if limits:
            env["WAFFLE_LAN_LIMITS"] = json.dumps(limits)
        self.p = subprocess.Popen(list(argv) + [room, salt], stdin=subprocess.PIPE, stdout=subprocess.PIPE, text=True, env=env)
        self.port = self.name = self.started = None

    async def line(self, timeout=60):
        text = await asyncio.wait_for(asyncio.get_running_loop().run_in_executor(None, self.p.stdout.readline), timeout)
        if not text:
            raise AssertionError("the driver ended (exit %s)" % self.p.poll())
        return text.rstrip("\n")

    async def reply(self):
        text = await self.line()
        assert text.startswith("REPLY "), ("a REPLY line", text)
        return json.loads(text[6:])

    async def start(self):
        first = (await self.line(120)).split(" ", 2)
        assert first[0] == "PORT", ("PORT <port> <name>", first)
        self.port, self.name = int(first[1]), first[2] if len(first) > 2 else ""
        self.started = await self.reply()
        return self

    async def host(self, peer):
        self.p.stdin.write("host %s\n" % peer)
        self.p.stdin.flush()
        return await self.reply()

    async def stop(self):
        if self.p.poll() is not None:
            return None
        self.p.stdin.write("\n")
        self.p.stdin.flush()
        stopped = await self.reply()
        assert await self.line() == "STOPPED"
        return stopped

    def kill(self):
        if self.p.poll() is None:
            self.p.kill()
        self.p.wait(5)


class Target:
    def __init__(self, name, argv, cleanup=None):
        self.name, self.argv, self.cleanup = name, argv, cleanup
        self.room, self.auth = room_for(b"lan")
        self.salt = "S" * 22

    async def launch(self, limits=None):
        return await Driver(self.argv, self.room, self.salt, limits).start()


# ---- the checks ------------------------------------------------------------------------------------------

async def check_replies(t):
    """lanStart, lanHost and lanStop reply alike on every host."""
    d = await t.launch()
    try:
        s = d.started
        assert set(s) == {"port", "addresses", "primary", "advertised", "name"}, ("lanStart keys", s)
        assert s["port"] == d.port and isinstance(s["port"], int) and 0 < s["port"] < 65536, s
        assert s["addresses"] == [] and s["primary"] is None, ("loopback only in the test", s)
        assert s["advertised"] is False and s["name"] == "Board review" == d.name, s
        assert await d.host("hostpeer0123456789") == {"ok": True}, "lanHost"
        assert await d.stop() == {"stopped": True}, "lanStop"
        await asyncio.sleep(0.3)
        assert not listening(d.port), "nothing listens after stop"
    finally:
        d.kill()


async def check_info(t):
    """{"t": "info"}: the public facts only (salt, name, host), once, and only before the join."""
    d = await t.launch()
    try:
        c = await Client.open(d.port)
        await c.send({"t": "info"})
        facts = await c.expect("info")
        assert facts == {"t": "info", "v": 2, "salt": t.salt, "name": "Board review", "host": None}, facts
        await c.send({"t": "info"})
        again = await c.expect("info")
        assert again.get("t") == "error" or "closed" in again, ("info is answered once", again)
        assert closed_code(again) or closed_code(await c.expect("closed")) in (1008, "eof"), "and the connection closes"
        assert await d.host("hostpeer0123456789") == {"ok": True}
        c2 = await Client.open(d.port)
        await c2.send({"t": "info"})
        assert (await c2.expect("info"))["host"] == "hostpeer0123456789", "the host's peer id once lanHost named it"
        c3 = await Client.open(d.port)
        await c3.send({"t": "join", "room": t.room, "auth": t.auth, "v": 2})
        await c3.expect("joined")
        await c3.send({"t": "info"})
        assert await c3.nothing() is None, "no info after joining"
        for c_ in (c2, c3):
            c_.close()
    finally:
        d.kill()


async def check_join_rules(t):
    """Only the shared room, with its token, and nothing else first."""
    d = await t.launch()
    try:
        other_room, other_auth = room_for(b"another")
        c = await Client.open(d.port)
        await c.send({"t": "join", "room": other_room, "auth": other_auth, "v": 2})
        m = await c.expect("joined")
        assert m.get("t") == "error" and "not shared here" in m["e"], ("only the shared room", m)
        assert closed_code(await c.expect("closed")) in (1008, "eof")
        c = await Client.open(d.port)
        await c.send({"t": "join", "room": t.room, "auth": "00" * 32, "v": 2})
        m = await c.expect("joined")
        assert m.get("t") == "error" and "room key" in m["e"], ("a wrong token is refused", m)
        assert closed_code(await c.expect("closed")) in (1008, "eof")
        for junk in ({"t": "hello"}, [1, 2], {"t": "join", "room": t.room}, {"t": "join", "room": "../x", "auth": t.auth}, "not json"):
            c = await Client.open(d.port)
            if isinstance(junk, str):
                c.frame(junk.encode())
                await c.writer.drain()
            else:
                await c.send(junk)
            m = await c.expect("joined")
            assert m.get("t") != "joined", ("refused", junk, m)
            if "closed" not in m:
                m = await c.expect("closed")
            assert closed_code(m) in (1008, "eof"), ("closed", junk, m)
    finally:
        d.kill()


async def check_routing(t):
    """The joined shape, peer notices, messages and signalling to the right peers, never echoed."""
    d = await t.launch()
    try:
        host = await Client.open(d.port)
        hj = await host.join(t.room, t.auth, own="owner-token-0123456789")
        assert set(hj) == {"t", "v", "id", "peers", "ice", "ttl", "owner"}, ("joined keys", hj)
        assert hj["v"] == 2 and CID.match(hj["id"]) and hj["peers"] == [] and hj["ice"] == [] and hj["owner"] is True, hj
        assert isinstance(hj["ttl"], int), hj
        g1 = await Client.open(d.port)
        await g1.send({"t": "info"})
        await g1.expect("info")
        j1 = await g1.join(t.room, t.auth)
        assert j1["peers"] == [hj["id"]] and j1["owner"] is False and j1["id"] != hj["id"], j1
        assert await host.recv() == {"t": "peer", "id": j1["id"], "joined": True}
        assert await host.recv() == {"t": "peers", "n": 1}
        g2 = await Client.open(d.port)
        j2 = await g2.join(t.room, t.auth)
        assert sorted(j2["peers"]) == sorted([hj["id"], j1["id"]]), j2
        for c in (host, g1):
            assert await c.expect("peer") == {"t": "peer", "id": j2["id"], "joined": True}
            assert await c.recv() == {"t": "peers", "n": 2}
        # To everyone else, with the sender's id; never back to the sender.
        await g1.send({"t": "m", "d": "ciphertext-1"})
        for c in (host, g2):
            assert await c.recv() == {"t": "m", "d": "ciphertext-1", "from": j1["id"]}
        assert await g1.nothing() is None, "no echo"
        # To named peers only (unknown ids and the sender itself are ignored).
        await host.send({"t": "m", "d": "to-g2", "to": [j2["id"], "c0000000000000000", hj["id"]]})
        assert await g2.recv() == {"t": "m", "d": "to-g2", "from": hj["id"]}
        assert await g1.nothing() is None and await host.nothing() is None, "an addressed message reaches only its recipients"
        await host.send({"t": "m", "d": "once", "to": [j2["id"], j2["id"], {"x": 1}, j2["id"]]})
        assert await g2.recv() == {"t": "m", "d": "once", "from": hj["id"]}
        assert await g2.nothing() is None, "each named recipient gets one copy"
        # Signalling to one peer, marked with its sender; at most 64 KiB; never to oneself.
        await g2.send({"t": "sig", "to": hj["id"], "d": "sealed-offer"})
        assert await host.recv() == {"t": "sig", "from": j2["id"], "d": "sealed-offer"}
        await g2.send({"t": "sig", "to": hj["id"], "d": "x" * R.Limits.signal})
        assert (await host.recv(5))["d"] == "x" * R.Limits.signal, "64 KiB of signalling is forwarded"
        await g2.send({"t": "sig", "to": hj["id"], "d": "x" * (R.Limits.signal + 1)})
        await g2.send({"t": "sig", "to": j2["id"], "d": "self"})
        assert await host.nothing() is None and await g2.nothing() is None and await g1.nothing() is None, "oversized or self signalling is dropped"
        # Anything else is dropped.
        for junk in ({"t": "m", "d": 5}, {"t": "x"}, {"t": "join", "room": t.room, "auth": t.auth}, {"t": "attest", "id": j1["id"]},
                     {"t": "ice"}, {"t": "sig", "to": j1["id"]}, [1]):
            await host.send(junk)
        assert await g1.nothing() is None and await g2.nothing() is None and await host.nothing() is None, "malformed messages are dropped"
        # A message in two fragments arrives whole; a ping gets its pong.
        text = json.dumps({"t": "m", "d": "fragmented"}).encode()
        g1.frame(text[:7], fin=False)
        g1.frame(text[7:], op=0x0)
        await g1.writer.drain()
        assert await host.recv() == {"t": "m", "d": "fragmented", "from": j1["id"]}
        assert (await g2.recv())["d"] == "fragmented"
        g1.frame(b"hi", op=0x9)
        await g1.writer.drain()
        assert await g1.frames() == (0xA, b"hi"), "pong"
        # Leaving is announced.
        g1.close()
        for c in (host, g2):
            assert await c.expect("peer") == {"t": "peer", "id": j1["id"], "joined": False}
            assert await c.recv() == {"t": "peers", "n": 1}
        # The owner may come back and is still the owner; another owner token is not.
        host.close()
        assert (await g2.expect("peer"))["joined"] is False
        again = await Client.open(d.port)
        assert (await again.join(t.room, t.auth, own="owner-token-0123456789"))["owner"] is True, "the owner rejoins"
        other = await Client.open(d.port)
        assert (await other.join(t.room, t.auth, own="someone-else-0123456789"))["owner"] is False, "a second owner token is not the owner"
        for c in (g2, again, other):
            c.close()
    finally:
        d.kill()


async def check_owner_pinned(t):
    """The owner is the first joiner with an owner token, for as long as the session is shared, even after
    everyone left and a guest came back first."""
    d = await t.launch()
    try:
        host = await Client.open(d.port)
        assert (await host.join(t.room, t.auth, own="owner-token-0123456789"))["owner"] is True
        host.close()
        await asyncio.sleep(0.3)
        guest = await Client.open(d.port)
        assert (await guest.join(t.room, t.auth, own="guest-token-0123456789"))["owner"] is False, "a guest does not take over"
        back = await Client.open(d.port)
        assert (await back.join(t.room, t.auth, own="owner-token-0123456789"))["owner"] is True, "the host is still the owner"
        for c in (guest, back):
            c.close()
    finally:
        d.kill()


async def check_http(t):
    """No HTTP pages on the network: no /healthz, no /join."""
    d = await t.launch()
    try:
        for path in ("/healthz", "/join", "/"):
            try:
                head, body = await asyncio.wait_for(http(d.port, path), 1.5)
            except (asyncio.IncompleteReadError, ConnectionError, asyncio.TimeoutError):
                continue
            assert not head.startswith("HTTP/1.1 2") and not body, ("no page", path, head, body[:80])
    finally:
        d.kill()


async def check_frames(t):
    """Unmasked, oversized and binary frames close the connection, before and after joining."""
    d = await t.launch()
    try:
        host = await Client.open(d.port)
        await host.join(t.room, t.auth, own="owner-token-0123456789")
        u = await Client.open(d.port)
        u.frame(json.dumps({"t": "info"}).encode(), masked=False)
        assert closed_code(await u.expect("closed")) in (1002, "eof"), "unmasked before joining"
        for label, send, codes in (("unmasked", lambda c: c.frame(json.dumps({"t": "m", "d": "x"}).encode(), masked=False), (1002, "eof")),
                                   ("oversized", lambda c: c.frame(b"x" * (R.Limits.frame + 10)), (1009, "eof")),
                                   ("binary", lambda c: c.frame(b"\x00\x01", op=0x2), (1003, "eof"))):
            c = await Client.open(d.port)
            j = await c.join(t.room, t.auth)
            assert (await host.expect("peer"))["id"] == j["id"]
            send(c)
            try:
                await c.writer.drain()
            except ConnectionError:
                pass
            assert closed_code(await c.expect("closed", 5)) in codes, label
            assert await host.expect("peer", 5) == {"t": "peer", "id": j["id"], "joined": False}, (label, "and it leaves the room")
        await host.send({"t": "m", "d": "still here"})
        assert await host.nothing() is None
        big = await Client.open(d.port)
        jb = await big.join(t.room, t.auth)
        await host.expect("peer")
        payload = json.dumps({"t": "m", "d": "y" * (R.Limits.frame - 64)})
        big.frame(payload.encode())
        await big.writer.drain()
        got = await host.expect("m", 10)
        assert got.get("from") == jb["id"] and len(got["d"]) == R.Limits.frame - 64, "a message just under 1 MiB is forwarded"
    finally:
        d.kill()


async def check_capacity(t):
    """16 people; the owner may still join a full room (two more connections)."""
    d = await t.launch()
    clients = []
    try:
        host = await Client.open(d.port)
        clients.append(host)
        await host.join(t.room, t.auth, own="owner-token-0123456789")
        for _ in range(R.Limits.peers - 1):
            c = await Client.open(d.port)
            clients.append(c)
            assert (await c.join(t.room, t.auth))["t"] == "joined"
        full = await Client.open(d.port)
        m = await full.join(t.room, t.auth)
        assert m.get("t") == "error" and "full" in m["e"], ("the 17th is refused", m)
        for n in (1, 2):
            o = await Client.open(d.port)
            clients.append(o)
            assert (await o.join(t.room, t.auth, own="owner-token-0123456789"))["owner"] is True, ("the owner is admitted", n)
        o = await Client.open(d.port)
        m = await o.join(t.room, t.auth, own="owner-token-0123456789")
        assert m.get("t") == "error" and "full" in m["e"], ("two more at most", m)
    finally:
        for c in clients:
            c.close()
        d.kill()


async def check_join_timeout(t):
    d = await t.launch({"join_timeout": 1})
    try:
        c = await Client.open(d.port)
        start = time.monotonic()
        assert closed_code(await c.expect("closed", 4)) in (1008, "eof"), "no join in time"
        assert time.monotonic() - start < 3
        c = await Client.open(d.port)
        await c.send({"t": "info"})
        await c.expect("info")
        assert closed_code(await c.expect("closed", 4)) in (1008, "eof"), "info, then no join in time"
    finally:
        d.kill()


async def check_idle(t):
    d = await t.launch({"idle": 1.5})
    try:
        quiet, talker = await Client.open(d.port), await Client.open(d.port)
        jq = await quiet.join(t.room, t.auth, own="owner-token-0123456789")
        await talker.join(t.room, t.auth)
        await quiet.expect("peers")
        start = time.monotonic()
        left = None
        while time.monotonic() - start < 4 and left is None:
            await talker.send({"t": "p"})   # a keepalive every half second (each is answered)
            until = time.monotonic() + 0.5
            while left is None:
                try:
                    m = await talker.recv(max(0.01, until - time.monotonic()))
                except asyncio.TimeoutError:
                    break
                if m.get("t") == "peer" and m.get("joined") is False:
                    left = m
        assert left and left["id"] == jq["id"], ("a connection with nothing to say for `idle` is closed", left)
        assert closed_code(await quiet.expect("closed", 1)) in (1001, "eof")
        while await talker.nothing(ignore=()) is not None:
            pass
        await talker.send({"t": "p"})
        assert await talker.recv() == {"t": "p"} and await talker.nothing() is None, "a keepalive keeps a connection"
    finally:
        d.kill()


async def check_room_joins(t):
    d = await t.launch({"room_joins": 3})
    try:
        host = await Client.open(d.port)
        await host.join(t.room, t.auth, own="owner-token-0123456789")
        for _ in range(3):
            assert (await (await Client.open(d.port)).join(t.room, t.auth))["t"] == "joined"
        m = await (await Client.open(d.port)).join(t.room, t.auth)
        assert m.get("t") == "error" and "Too many joins into this session" in m["e"], m
        assert (await (await Client.open(d.port)).join(t.room, t.auth, own="owner-token-0123456789"))["owner"] is True, "the owner may rejoin"
    finally:
        d.kill()


async def check_joins(t):
    d = await t.launch({"joins": 4, "room_joins": 100})
    try:
        for _ in range(4):
            assert (await (await Client.open(d.port)).join(t.room, t.auth))["t"] == "joined"
        m = await (await Client.open(d.port)).join(t.room, t.auth)
        assert m.get("t") == "error" and "Too many joins from this address" in m["e"], m
    finally:
        d.kill()


async def check_per_address(t):
    d = await t.launch({"per_address": 3})
    try:
        open_ = [await Client.open(d.port) for _ in range(3)]
        extra = await Client.raw(d.port)
        head = await extra.upgrade()
        assert not head.startswith(b"HTTP/1.1 101"), ("a fourth connection from one address is refused", head)
        open_[0].close()
        await asyncio.sleep(0.3)
        again = await Client.open(d.port)
        await again.send({"t": "info"})
        assert (await again.expect("info"))["t"] == "info", "a connection slot frees up when one closes"
    finally:
        d.kill()


async def check_connections(t):
    """All connections together: four per place in the room (peers 2: 8)."""
    d = await t.launch({"peers": 2, "per_address": 100})
    try:
        open_ = [await Client.open(d.port) for _ in range(8)]
        extra = await Client.raw(d.port)
        head = await extra.upgrade()
        assert not head.startswith(b"HTTP/1.1 101"), ("connections past 4 x peers are refused", head)
        for c in open_:
            c.close()
    finally:
        d.kill()


async def check_rate(t):
    """Past its budget a sender waits; every message arrives, in order, and it is never cut off."""
    d = await t.launch({"rate_messages": 20, "rate_window": 0.5})
    try:
        f, g = await Client.open(d.port), await Client.open(d.port)
        await f.join(t.room, t.auth, own="owner-token-0123456789")
        await g.join(t.room, t.auth)
        start = time.monotonic()
        for i in range(60):
            f.frame(json.dumps({"t": "m", "d": "n%d" % i}).encode())
        await f.writer.drain()
        got = [(await g.expect("m", 5)).get("d") for _ in range(60)]
        assert got == ["n%d" % i for i in range(60)], ("every message arrives, in order", got[:3], got[-3:])
        assert time.monotonic() - start >= 2 * 0.5 * 0.9, "past its budget the sender waited"
        await f.send({"t": "m", "d": "still here"})
        assert (await g.expect("m"))["d"] == "still here", "and is not cut off"
    finally:
        d.kill()


async def check_rate_bytes(t):
    d = await t.launch({"rate_bytes": 200000, "rate_window": 0.5})
    try:
        f, g = await Client.open(d.port), await Client.open(d.port)
        await f.join(t.room, t.auth, own="owner-token-0123456789")
        await g.join(t.room, t.auth)
        start = time.monotonic()
        for i in range(10):
            f.frame(json.dumps({"t": "m", "d": "%d" % i + "b" * 50000}).encode())
        await f.writer.drain()
        got = [(await g.expect("m", 5)).get("d", "")[:1] for _ in range(10)]
        assert got == [str(i) for i in range(10)], got
        assert time.monotonic() - start >= 2 * 0.5 * 0.9, "past its byte budget the sender waited"
    finally:
        d.kill()


async def check_stall(t):
    """A peer that stops reading holds its senders back at most `stall` at a time, then it gets nothing
    more but a close (as the relay: it is cut off, and leaves the room when its connection ends); the
    others get everything, in order."""
    d = await t.launch({"queue": 256 * 1024, "queue_soft": 128 * 1024, "stall": 0.5, "rate_bytes": 1 << 30, "rate_messages": 1 << 20})
    try:
        s1 = await Client.open(d.port)
        await s1.join(t.room, t.auth, own="owner-token-0123456789")
        s2 = await Client.open(d.port, rcvbuf=4096)
        await s2.join(t.room, t.auth)
        s3 = await Client.open(d.port)
        await s3.join(t.room, t.auth)
        chunk = "y" * 60000
        start = time.monotonic()
        n = 600   # 36 MB: more than socket buffers hold (macOS lets each side grow to 4 MB)
        for i in range(n):
            await s1.send({"t": "m", "d": chunk + str(i)})
            while True:
                m = await s3.recv(8)
                assert "closed" not in m, m
                if m.get("t") == "m":
                    assert m["d"] == chunk + str(i), "the healthy peer gets everything, in order"
                    break
        took = time.monotonic() - start
        assert took < 20, ("senders were held back only while the stalled peer had its chance", took)
        got, end = 0, None
        while end is None:
            m = await s2.recv(5)
            if "closed" in m:
                end = m["closed"]
            elif m.get("t") == "m":
                got += 1
        assert end is not None and got < n, ("the stalled peer was cut off", end, got)
        await s1.send({"t": "m", "d": "after"})
        while (m := await s3.recv(5)).get("t") != "m":
            pass
        assert m["d"] == "after", "the sender is still in the room"
    finally:
        d.kill()


async def check_quiet_room(t):
    """A room on the local network is never closed for being quiet (its people connected, nothing
    forwarded): the public relay's room_idle protects it from abandoned rooms, but a LAN listener ends
    with the host's session. lan_room_idle (off by default) is the one switch for it."""
    d = await t.launch({"room_idle": 1, "sweep": 0.25})
    try:
        a, b = await Client.open(d.port), await Client.open(d.port)
        ja = await a.join(t.room, t.auth, own="owner-token-0123456789")
        await b.join(t.room, t.auth)
        for _ in range(10):   # 2.5 s: ten sweeps past room_idle, keepalives only
            await a.send({"t": "p"})
            await b.send({"t": "p"})
            await asyncio.sleep(0.25)
        assert await a.nothing(ignore=("p", "peer", "peers")) is None and await b.nothing(ignore=("p", "peer", "peers")) is None, "nobody is closed"
        await a.send({"t": "m", "d": "still here"})
        assert await b.expect("m") == {"t": "m", "d": "still here", "from": ja["id"]}, "and the room still forwards"
    finally:
        d.kill()
    d = await t.launch({"lan_room_idle": 1, "sweep": 0.25})
    try:
        a, b = await Client.open(d.port), await Client.open(d.port)
        await a.join(t.room, t.auth, own="owner-token-0123456789")
        await b.join(t.room, t.auth)
        ends, start = {}, time.monotonic()
        while len(ends) < 2 and time.monotonic() - start < 4:   # pings answered, but they are no room activity
            for name, c in (("a", a), ("b", b)):
                if name in ends:
                    continue
                try:
                    await c.send({"t": "p"})
                except ConnectionError:
                    pass
                try:
                    m = await c.recv(0.25)
                except asyncio.TimeoutError:
                    continue
                if "closed" in m:
                    ends[name] = m["closed"]
        assert sorted(ends) == ["a", "b"] and all(c in (1001, None, "eof") for c in ends.values()), ("with lan_room_idle set, a quiet room is closed", ends)
    finally:
        d.kill()


async def check_ping(t):
    """The keepalive is answered: {"t": "p"} gets exactly {"t": "p"}, to the sender only, never to the
    room; only after the join (before it, a ping is not a join); within the rate limit like any message;
    and it keeps its own connection from the idle timeout (it is that connection's traffic, as on the
    relay), while it is no room activity (see quiet_room)."""
    d = await t.launch()
    try:
        host, guest, third = await Client.open(d.port), await Client.open(d.port), await Client.open(d.port)
        await host.join(t.room, t.auth, own="owner-token-0123456789")
        await guest.join(t.room, t.auth)
        await third.join(t.room, t.auth)
        for c in (host, guest):
            while await c.nothing(ignore=()) is not None:
                pass
        await guest.send({"t": "p"})
        assert await guest.frames() == (0x1, b'{"t":"p"}'), "exactly {\"t\":\"p\"}"
        assert await host.nothing(ignore=()) is None and await third.nothing(ignore=()) is None, "to the sender only"
        early = await Client.open(d.port)
        await early.send({"t": "p"})
        m = await early.expect("p")
        assert m.get("t") != "p", ("a ping before the join is no join", m)
    finally:
        d.kill()
    d = await t.launch({"rate_messages": 20, "rate_window": 0.5, "idle": 2.5})
    try:
        f, g = await Client.open(d.port), await Client.open(d.port)
        await f.join(t.room, t.auth, own="owner-token-0123456789")
        await g.join(t.room, t.auth)
        start = time.monotonic()
        for _ in range(60):
            f.frame(b'{"t":"p"}')
        await f.writer.drain()
        got = 0
        while got < 60:
            m = await f.recv(5)
            assert "closed" not in m, ("a fast pinger is slowed, not cut off", m)
            got += m.get("t") == "p"
        assert time.monotonic() - start >= 2 * 0.5 * 0.9, "pings count against the rate limit"
        assert await g.nothing() is None, "and none reached the room"
        for _ in range(8):   # 4 s of pings every 0.5 s: past the 2.5 s idle timeout
            for c in (f, g):
                await c.send({"t": "p"})
                assert await c.expect("p") == {"t": "p"}
            await asyncio.sleep(0.5)
        await f.send({"t": "m", "d": "still here"})
        assert (await g.expect("m"))["d"] == "still here", "pings keep their own connection open"
    finally:
        d.kill()


async def check_stop(t):
    """Stopping closes the room's connections and the port."""
    d = await t.launch()
    try:
        c = await Client.open(d.port)
        await c.join(t.room, t.auth, own="owner-token-0123456789")
        assert await d.stop() == {"stopped": True}
        assert closed_code(await c.expect("closed", 5)) in (1001, 1000, "eof"), "connections end with the listener"
        await asyncio.sleep(0.3)
        assert not listening(d.port)
    finally:
        d.kill()


CHECKS = [check_replies, check_info, check_join_rules, check_routing, check_owner_pinned, check_http, check_frames,
          check_capacity, check_join_timeout, check_idle, check_room_joins, check_joins, check_per_address,
          check_connections, check_rate, check_rate_bytes, check_stall, check_quiet_room, check_ping, check_stop]


async def conformance(target, only=None):
    results = []
    for check in CHECKS:
        name = check.__name__[len("check_"):]
        if only and name not in only:
            continue
        start = time.monotonic()
        try:
            await asyncio.wait_for(check(target), 90)
            results.append((name, None, time.monotonic() - start))
        except Exception as e:   # noqa: BLE001 - a failed check is reported and the suite goes on
            results.append((name, "%s: %s" % (type(e).__name__, e), time.monotonic() - start))
    return results


# ---- the targets' drivers ----------------------------------------------------------------------------

def apply_limits(limits_class):
    """WAFFLE_LAN_LIMITS for the Python listener (waffle_relay.Limits)."""
    for key, value in json.loads(os.environ.get("WAFFLE_LAN_LIMITS") or "{}").items():
        if not hasattr(limits_class, key):
            raise SystemExit("unknown limit %s" % key)
        setattr(limits_class, key, type(getattr(limits_class, key))(value))


def linux_driver(room, salt):
    """The Linux listener's driver (the driver contract above)."""
    apply_limits(R.Limits)
    lan = L.LanRelay(addresses=[], advertise=False)   # loopback only in the test
    assert not lan.running
    started = lan.start(room, salt, NAME)
    print("PORT %d %s" % (started["port"], started["name"]))
    print("REPLY " + json.dumps(started), flush=True)
    for line in sys.stdin:
        if line.startswith("host "):
            print("REPLY " + json.dumps(L.handle(lan, "lanHost", {"host": line[5:].strip()})), flush=True)
            continue
        break
    print("REPLY " + json.dumps(L.handle(lan, "lanStop", {})))
    print("STOPPED", flush=True)
    return 0


SWIFT_DRIVER = r'''
import Foundation
let a = CommandLine.arguments
if let raw = ProcessInfo.processInfo.environment["WAFFLE_LAN_LIMITS"], let data = raw.data(using: .utf8),
   let limits = (try? JSONSerialization.jsonObject(with: data)) as? [String: Double] {
    for (key, value) in limits { guard LanRelay.Limits.set(key, value) else { print("ERROR limit \(key)"); exit(1) } }
}
func line(_ obj: [String: Any]) -> String { String(data: try! JSONSerialization.data(withJSONObject: obj, options: [.sortedKeys]), encoding: .utf8)! }
let relay = LanRelay()
relay.start(room: a[1], salt: a[2], name: "Board  review", advertise: false, loopbackOnly: true) { result in
    switch result {
    case .success(let info): print("PORT \(info["port"]!) \(info["name"]!)"); print("REPLY " + line(info)); fflush(stdout)
    case .failure(let e): print("ERROR \(e)"); fflush(stdout); exit(1)
    }
}
DispatchQueue.global().async {
    while let text = readLine(), text.hasPrefix("host ") { print("REPLY " + line(relay.setHost(String(text.dropFirst(5))))); fflush(stdout) }
    print("REPLY " + line(relay.stop())); print("STOPPED"); fflush(stdout); exit(0)
}
RunLoop.main.run()
'''


def swift_build(tmp, driver_source, name):
    folder = Path(tmp) / name
    folder.mkdir()
    driver, binary = folder / "main.swift", Path(tmp) / ("bin-" + name)   # top-level code: main.swift
    driver.write_text(driver_source)
    subprocess.run(["xcrun", "swiftc", "-swift-version", "5", "-module-cache-path", str(Path(tmp) / "cache"),
                    str(ROOT / "native" / "macos" / "LanRelay.swift"), str(driver), "-o", str(binary)], check=True)
    return binary


def windows_build(tmp):
    """The Windows test program (native/windows/tests), whose --lan-relay mode is the C# listener's driver."""
    dotnet = os.environ.get("DOTNET") or shutil.which("dotnet")
    if not dotnet:
        raise SystemExit("--target windows needs the .NET SDK 8 or later: dotnet on PATH, or DOTNET=/path/to/dotnet")
    out = Path(tmp) / "windows"
    subprocess.run([dotnet, "build", str(ROOT / "native" / "windows" / "tests"), "-c", "Release", "-o", str(out), "-nologo", "-v:quiet"], check=True,
                   env=dict(os.environ, DOTNET_CLI_TELEMETRY_OPTOUT="1", DOTNET_NOLOGO="1"))
    return [dotnet, str(out / "Waffle.Windows.Tests.dll"), "--lan-relay"]


# ---- what only one host has ------------------------------------------------------------------------------

def linux_unit():
    """The Linux listener binds loopback and only the private addresses of physical interfaces; avahi
    output becomes sessions."""
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
        "=;wlp2s0;IPv6;Board\\032review;_waffle._tcp;local;alice.local;fd12::5;48765;\"v=2\"",
        "=;wlp2s0;IPv4;Printer;_ipp._tcp;local;p.local;192.168.1.5;631;",
        "=;wlp2s0;IPv4;Board\\032review;_waffle._tcp;local;alice.local;192.168.1.20;48765;\"v=2\""])
    assert L.parse_browse(browse) == [{"name": "Board review", "address": "192.168.1.20", "port": 48765},
                                      {"name": "Board review", "address": "fd12::5", "port": 48765}], L.parse_browse(browse)
    # The bound sockets: loopback only when no address is given.
    lan = L.LanRelay(addresses=[], advertise=False)
    started = lan.start(room_for(b"lan")[0], "S" * 22, NAME)
    try:
        assert sorted({s.getsockname()[0] for s in lan.server.sockets}) == ["127.0.0.1"]
    finally:
        lan.stop()
    assert not listening(started["port"])
    try:
        L.LanRelay(addresses=[], advertise=False).start("nope", "S" * 22, "x")
        raise AssertionError("a bad session id is refused")
    except ValueError as e:
        assert str(e) == "Not a session id.", e
    return "addresses, avahi parsing, loopback binding"


# The default port is taken (another window or app already shares on this network): a second relay must
# fall back to a free port. The fallback runs in the listener's state handler, on the relay's queue; it
# once did queue.sync onto that same queue and crashed (SIGTRAP).
FALLBACK_DRIVER = r'''
import Foundation
let a = CommandLine.arguments
let first = LanRelay(), second = LanRelay()
first.start(room: a[1], salt: a[2], name: "First", advertise: false, loopbackOnly: true) { r in
    guard case .success(let one) = r else { print("ERROR first \(r)"); fflush(stdout); exit(1) }
    second.start(room: a[1], salt: a[2], name: "Second  window", advertise: false, loopbackOnly: true) { r2 in
        switch r2 {
        case .success(let two): print("PORTS \(one["port"]!) \(two["port"]!) \(two["name"]!)"); fflush(stdout)
        case .failure(let e): print("ERROR second \(e)"); fflush(stdout); exit(1)
        }
        DispatchQueue.global().async { _ = readLine(); _ = first.stop(); _ = second.stop(); print("STOPPED"); fflush(stdout); exit(0) }
    }
}
DispatchQueue.global().asyncAfter(deadline: .now() + 15) { print("TIMEOUT"); fflush(stdout); exit(2) }
RunLoop.main.run()
'''


async def macos_unit(tmp, room, salt):
    binary = swift_build(tmp, FALLBACK_DRIVER, "fallback")
    p = subprocess.Popen([str(binary), room, salt], stdin=subprocess.PIPE, stdout=subprocess.PIPE, text=True)
    try:
        line = p.stdout.readline().split()
        assert line and line[0] == "PORTS", ("the second relay falls back to a free port", line, p.poll())
        one, two = int(line[1]), int(line[2])
        assert two not in (0, one, L.PORT), ("a different, free port", line)
        assert " ".join(line[3:]) == "Second window", line
        c = await Client.open(two)
        await c.send({"t": "info"})
        facts = await c.expect("info")
        assert facts["salt"] == salt and facts["name"] == "Second window", facts
        c.close()
        p.stdin.write("\n")
        p.stdin.flush()
        assert p.stdout.readline().strip() == "STOPPED"
    finally:
        p.kill()
    return "free-port fallback"


# ---- main --------------------------------------------------------------------------------------------

async def main(argv):
    parser = argparse.ArgumentParser(description=__doc__.split("\n\n")[0])
    parser.add_argument("--target", action="append", default=[], help="linux, macos, windows or NAME=COMMAND (repeatable)")
    parser.add_argument("--only", action="append", default=[], help="run only this check (repeatable)")
    args = parser.parse_args(argv)
    names = args.target or (["linux"] + (["macos"] if platform.system() == "Darwin" and shutil.which("xcrun") else [])
                            + (["windows"] if os.environ.get("DOTNET") or shutil.which("dotnet") else []))
    failed, lines = False, []
    with tempfile.TemporaryDirectory() as tmp:
        targets, extras = [], {}
        for name in names:
            if "=" in name:
                label, command = name.split("=", 1)
                targets.append(Target(label, shlex.split(command)))
            elif name == "linux":
                targets.append(Target("linux", [sys.executable, str(Path(__file__).resolve()), "--driver"]))
                extras["linux"] = linux_unit()
            elif name == "macos":
                targets.append(Target("macos", [str(swift_build(tmp, SWIFT_DRIVER, "conformance"))]))
                extras["macos"] = await macos_unit(tmp, *room_for(b"lan")[:1], "S" * 22)
            elif name == "windows":
                targets.append(Target("windows", windows_build(tmp)))
            else:
                raise SystemExit("unknown target %s" % name)
        for target in targets:
            results = await conformance(target, args.only)
            bad = [r for r in results if r[1]]
            failed = failed or bool(bad)
            for name, error, took in results:
                print("%-8s %-14s %s  (%.1fs)" % (target.name, name, "ok" if not error else "FAIL " + error, took), flush=True)
            lines.append("%s: %d/%d checks%s" % (target.name, len(results) - len(bad), len(results),
                                                   "" if target.name not in extras else "; " + extras[target.name]))
    print("lan_relay: %s (%s)" % ("FAILED" if failed else "ok", "; ".join(lines)))
    return 1 if failed else 0


if __name__ == "__main__":
    if len(sys.argv) == 4 and sys.argv[1] == "--driver":
        sys.exit(linux_driver(sys.argv[2], sys.argv[3]))
    sys.exit(asyncio.run(main(sys.argv[1:])))
