#!/usr/bin/env python3
"""The self-hosted collaboration relay (collab/relay/waffle_relay.py): join checks, forwarding
within a room only (to everyone or to named peers), signalling, no echo, framing limits, a rate
limit that slows a sender down without cutting it off, per-peer queues (a stalled peer cannot hold
back the others), room and address limits, the room owner, TURN credentials, /healthz, /join and
the --dev file server. Standard library only.

    python3 tests/project/collab-relay.py
"""
import asyncio
import base64
import hashlib
import hmac
import json
import os
from pathlib import Path
import struct
import sys
import time

ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, os.environ.get("ATRIUM_RELAY_DIR") or str(ROOT / "collab" / "relay"))   # the server kit tests its packed copy
import waffle_relay as R  # noqa: E402


class Client:
    def __init__(self, reader, writer):
        self.reader, self.writer = reader, writer

    @classmethod
    async def open(cls, port, handshake=True, headers=""):
        reader, writer = await asyncio.open_connection("127.0.0.1", port)
        c = cls(reader, writer)
        if handshake:
            key = base64.b64encode(os.urandom(16)).decode()
            writer.write(("GET / HTTP/1.1\r\nHost: x\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n"
                          "Sec-WebSocket-Key: %s\r\nSec-WebSocket-Version: 13\r\n%s\r\n" % (key, headers)).encode())
            head = await reader.readuntil(b"\r\n\r\n")
            assert head.startswith(b"HTTP/1.1 101"), head
            want = base64.b64encode(hashlib.sha1(key.encode() + R.GUID).digest())
            assert want in head, "Sec-WebSocket-Accept"
        return c

    def frame(self, payload, op=0x1, masked=True, fin=True):
        n = len(payload)
        head = bytes([(0x80 if fin else 0) | op])
        m = 0x80 if masked else 0
        head += bytes([m | n]) if n < 126 else bytes([m | 126]) + struct.pack("!H", n) if n < 65536 else bytes([m | 127]) + struct.pack("!Q", n)
        if masked:
            mask = os.urandom(4)
            payload = bytes(b ^ mask[i % 4] for i, b in enumerate(payload)) if n < 4096 else R.unmask(payload, mask)
            head += mask
        self.writer.write(head + payload)

    async def send(self, obj):
        self.frame(json.dumps(obj).encode())
        await self.writer.drain()

    async def recv(self, timeout=2.0):
        head = await asyncio.wait_for(self.reader.readexactly(2), timeout)
        op, n = head[0] & 0x0F, head[1] & 0x7F
        if n == 126:
            n = struct.unpack("!H", await self.reader.readexactly(2))[0]
        elif n == 127:
            n = struct.unpack("!Q", await self.reader.readexactly(8))[0]
        data = await self.reader.readexactly(n)
        if op == 0x8:
            return {"closed": struct.unpack("!H", data[:2])[0] if len(data) >= 2 else None}
        return json.loads(data)

    async def next(self, kind, timeout=2.0):
        """The next message of one kind, skipping peer-count notices."""
        while True:
            m = await self.recv(timeout)
            if m.get("t") == kind or "closed" in m:
                return m

    async def closed(self, timeout=2.0):
        """The next close frame code, skipping other messages (or EOF)."""
        try:
            while True:
                m = await self.recv(timeout)
                if "closed" in m:
                    return m["closed"]
        except (asyncio.IncompleteReadError, ConnectionError):
            return "eof"

    async def nothing(self, timeout=.3, ignore=("peers", "peer")):
        try:
            while True:
                m = await self.recv(timeout)
                if m.get("t") not in ignore:
                    return m
        except asyncio.TimeoutError:
            return None

    async def join(self, room, auth, **extra):
        await self.send({"t": "join", "room": room, "auth": auth, "v": 2, **extra})
        return await self.next("joined")


def room_for(secret):
    auth = hashlib.sha256(secret).digest()
    return hashlib.sha256(auth).hexdigest(), auth.hex()


async def http(port, path, headers=""):
    reader, writer = await asyncio.open_connection("127.0.0.1", port)
    writer.write(("GET %s HTTP/1.1\r\nHost: x\r\n%s\r\n" % (path, headers)).encode())
    head = await reader.readuntil(b"\r\n\r\n")
    length = int(next((l.split(b":")[1] for l in head.split(b"\r\n") if l.lower().startswith(b"content-length:")), b"0"))
    body = await reader.readexactly(length) if length else b""
    writer.close()
    return head.decode("latin-1"), body


async def main():
    secret = b"0123456789abcdef0123456789abcdef"
    R.Limits.rooms_per_address = 1000   # every test client is 127.0.0.1; the limit is tested on its own below
    relay = R.Relay(quiet=True, turn=R.Turn(secret, "turn.example.org", ttl=600))
    port_box, started = [], asyncio.Event()
    task = asyncio.create_task(R.run("127.0.0.1", 0, quiet=True, relay=relay, ready=lambda p: (port_box.append(p), started.set())))
    await started.wait()
    port = port_box[0]
    room, auth = room_for(b"room one")
    other_room, other_auth = room_for(b"room two")

    # Joining needs the token for the room id.
    bad = await Client.open(port)
    await bad.send({"t": "join", "room": room, "auth": other_auth})
    m = await bad.recv()
    assert m["t"] == "error" and "room key" in m["e"], m
    assert await bad.closed() in (1008, "eof")
    for junk in ({"t": "join", "room": room}, {"t": "hello"}, {"t": "join", "room": "../x", "auth": auth}, [1, 2]):
        c = await Client.open(port)
        await c.send(junk)
        assert await c.closed() in (1008, "eof"), junk

    # Two peers in a room: connection ids, the newcomer learns who is there, the others hear of it.
    a, b, x = await Client.open(port), await Client.open(port), await Client.open(port)
    ja = await a.join(room, auth, own="host-owner-token-0123456789")
    assert R.CID.match(ja["id"]) and ja["peers"] == [] and ja["v"] == 2 and ja["owner"] is True, ja
    assert ja["ice"] == [{"urls": ["stun:turn.example.org:3478"]}], "STUN only: no TURN for a room with nobody else in it"
    await a.send({"t": "ice"})
    assert await a.nothing() is None, "nor on request"
    jb = await b.join(room, auth)
    assert jb["peers"] == [ja["id"]] and jb["id"] != ja["id"] and jb["owner"] is False, jb
    assert not any("username" in s for s in jb["ice"])
    assert await a.next("peer") == {"t": "peer", "id": jb["id"], "joined": True}
    # A stranger with a second connection gets no TURN either: only the host's word that this
    # connection proved it holds the room key counts, and only the owner can give it.
    await b.send({"t": "attest", "id": jb["id"]}); await b.send({"t": "ice"})
    assert await b.nothing() is None and await a.nothing() is None, "a member cannot vouch for itself"
    await a.send({"t": "attest", "id": jb["id"]})
    ia, ib = await a.next("ice"), await b.next("ice")
    await x.join(other_room, other_auth)

    # TURN credentials: coturn's REST scheme, minted per vouched member, short-lived.
    turn = [s for s in ia["ice"] if "username" in s][0]
    expiry, _ = turn["username"].split(":")
    assert 0 < int(expiry) - time.time() <= 600 and ia["ttl"] == 600
    assert turn["credential"] == base64.b64encode(hmac.new(secret, turn["username"].encode(), hashlib.sha1).digest()).decode()
    assert "turns:turn.example.org:5349?transport=tcp" in turn["urls"] and {"urls": ["stun:turn.example.org:3478"]} in ia["ice"]
    assert [s for s in ib["ice"] if "username" in s][0]["username"] != turn["username"], "fresh credentials per member"
    await a.send({"t": "ice"})
    assert await a.nothing() is None, "credential refreshes are rate limited"

    # Messages reach the others with the sender's connection id, never the sender, never another room.
    await a.send({"t": "m", "d": "ciphertext-1"})
    assert await b.next("m") == {"t": "m", "d": "ciphertext-1", "from": ja["id"]}
    assert await a.nothing() is None, "no echo to the sender"
    assert await x.nothing() is None, "nothing crosses rooms"
    c = await Client.open(port)
    jc = await c.join(room, auth)
    await b.send({"t": "m", "d": "only-c", "to": [jc["id"], "c0000000000000000", ja["id"] + "x"]})
    assert await c.next("m") == {"t": "m", "d": "only-c", "from": jb["id"]}
    assert await a.nothing() is None, "an addressed message reaches only its recipients"
    await b.send({"t": "m", "d": "once", "to": [jc["id"], jc["id"], [1], jc["id"]]})
    assert await c.next("m") == {"t": "m", "d": "once", "from": jb["id"]}
    assert await c.nothing() is None, "each named recipient gets one copy"
    # Signalling goes to one peer, marked with its sender.
    await c.send({"t": "sig", "to": ja["id"], "d": "sealed-offer"})
    assert await a.next("sig") == {"t": "sig", "from": jc["id"], "d": "sealed-offer"}
    assert await b.nothing() is None
    await c.send({"t": "sig", "to": ja["id"], "d": "x" * (R.Limits.signal + 1)})
    assert await a.nothing() is None, "oversized signalling is dropped"
    # Only well-formed messages are forwarded; anything else is dropped.
    await a.send({"t": "m", "d": 5}); await a.send({"t": "join", "room": other_room, "auth": other_auth}); await a.send({"t": "x"}); await a.send({"t": "p"})
    assert await b.nothing() is None

    # Close the third peer before reusing its client variable later in this scenario.
    c.writer.close()
    assert await a.next("peer") == {"t": "peer", "id": jc["id"], "joined": False}

    # Unmasked client frames and oversized frames close the connection.
    u = await Client.open(port)
    u.frame(json.dumps({"t": "join", "room": room, "auth": auth}).encode(), masked=False)
    assert await u.closed() in (1002, "eof")
    big = await Client.open(port)
    await big.join(other_room, other_auth)
    big.frame(b"x" * (R.Limits.frame + 10))
    assert await big.closed() in (1009, "eof")
    binary = await Client.open(port)
    await binary.join(other_room, other_auth)
    binary.frame(b"\x00\x01", op=0x2)
    assert await binary.closed() in (1003, "eof")

    # HTTP: health, the invitation page (no secrets reach the server), nothing else.
    head, body = await http(port, "/healthz")
    assert head.startswith("HTTP/1.1 200") and json.loads(body)["ok"] and json.loads(body)["turn"] is True, head
    assert "rooms" not in json.loads(body), "health reveals no usage"
    assert "Access-Control-Allow-Origin: *" in head, "Preferences › Test Connection may read it"
    head, body = await http(port, "/join")
    assert head.startswith("HTTP/1.1 200") and b"after <code>#</code>" in body and "no-store" in head
    assert (await http(port, "/"))[0].startswith("HTTP/1.1 426")
    assert (await http(port, "/app/index.html"))[0].startswith("HTTP/1.1 404"), "the editor is served only with --dev"

    # The rate limit slows a fast sender down; it never cuts it off (the host keeps its own room).
    old = R.Limits.rate_messages, R.Limits.rate_window
    R.Limits.rate_messages, R.Limits.rate_window = 20, .5
    f, g = await Client.open(port), await Client.open(port)
    fr, gr = room_for(b"flood")
    await f.join(fr, gr)
    await g.join(fr, gr)
    start = time.monotonic()
    for i in range(60):
        f.frame(json.dumps({"t": "m", "d": "n%d" % i}).encode())
    await f.writer.drain()
    got = [(await g.next("m", 5))["d"] for _ in range(60)]
    assert got == ["n%d" % i for i in range(60)], "every message arrives, in order"
    assert time.monotonic() - start >= 2 * R.Limits.rate_window * .9, "past its budget the sender waited"
    await f.send({"t": "m", "d": "still here"})
    assert (await g.next("m"))["d"] == "still here"
    R.Limits.rate_messages, R.Limits.rate_window = old

    # A stalled peer (it stops reading) holds its senders back at most Limits.stall, then it is cut off.
    old = R.Limits.queue, R.Limits.queue_soft, R.Limits.stall
    R.Limits.queue, R.Limits.queue_soft, R.Limits.stall = 256 * 1024, 128 * 1024, .5
    sr, sa = room_for(b"stall")
    s1, s2, s3 = await Client.open(port), await Client.open(port), await Client.open(port)
    await s1.join(sr, sa); j2 = await s2.join(sr, sa); await s3.join(sr, sa)
    stalled = relay.rooms[sr]["peers"][j2["id"]]
    never = asyncio.get_running_loop().create_future()
    stalled.writer.drain = lambda: never        # this peer's network stopped draining
    chunk = "y" * 60000
    start = time.monotonic()
    for i in range(12):
        await s1.send({"t": "m", "d": chunk + str(i)})
        assert (await s3.next("m", 5))["d"] == chunk + str(i), "the healthy peer gets everything, in order"
    assert time.monotonic() - start < 3 * R.Limits.stall + 1, "held back only while the stalled peer had its chance"
    assert stalled.closing, "the stalled peer is cut off"
    assert stalled.queued == 0
    R.Limits.queue, R.Limits.queue_soft, R.Limits.stall = old

    # Memory (security review): rooms with a peer that never reads and senders of large frames. The
    # senders stop being read, the stalled peers are cut off, and every queue stays within its budget.
    old = R.Limits.queue_soft, R.Limits.stall
    R.Limits.queue_soft, R.Limits.stall = 2 * 1024 * 1024, 1.0
    peak = [0]
    push = R.Peer.push
    def counting(self, data):
        ok = push(self, data)
        peak[0] = max(peak[0], R.Peer.total)
        assert self.queued <= R.Limits.queue
        return ok
    R.Peer.push = counting
    senders, sleepers = [], []
    for n in range(6):
        mr, ma = room_for(b"memory %d" % n)
        sender, sleeper = await Client.open(port), await Client.open(port)
        await sender.join(mr, ma); js = await sleeper.join(mr, ma)
        relay.rooms[mr]["peers"][js["id"]].writer.drain = lambda: asyncio.get_running_loop().create_future()
        senders.append(sender); sleepers.append(js["id"])
    big = json.dumps({"t": "m", "d": "z" * (R.Limits.frame - 200)}).encode()
    async def blast(c):
        try:
            for _ in range(20):
                c.frame(big)
                await asyncio.wait_for(c.writer.drain(), 10)
        except (asyncio.TimeoutError, ConnectionError):
            pass
    await asyncio.wait_for(asyncio.gather(*(blast(c) for c in senders)), 60)
    await asyncio.sleep(.5)
    R.Peer.push = push
    assert peak[0] <= 6 * R.Limits.queue, "queued bytes stay bounded (%d)" % peak[0]
    assert peak[0] <= R.Limits.queue_total + R.Limits.frame
    assert all(p.closing for room_ in relay.rooms.values() for p in room_["peers"].values() if p.id in sleepers), "peers that never read are cut off"
    assert R.Peer.total >= 0
    for c in senders:
        c.writer.close()
    R.Limits.queue_soft, R.Limits.stall = old

    # Every queue together has one budget: past it, senders wait.
    old = R.Limits.queue_total, R.Limits.stall
    R.Limits.queue_total, R.Limits.stall = 0, .5
    gr2, ga2 = room_for(b"global budget")
    g1, g2 = await Client.open(port), await Client.open(port)
    await g1.join(gr2, ga2); jg2 = await g2.join(gr2, ga2)
    relay.rooms[gr2]["peers"][jg2["id"]].writer.drain = lambda: asyncio.get_running_loop().create_future()
    for word in ("one", "two", "three"):   # the first leaves the queue for the socket; the rest wait
        await g1.send({"t": "m", "d": word})
    assert await g1.closed(5) in (1013, "eof") or relay.rooms.get(gr2) is None or all(p.closing for p in relay.rooms[gr2]["peers"].values()), \
        "a sender is not read past the global budget"
    R.Limits.queue_total, R.Limits.stall = old

    # Messages being read count too (a 1 MB frame from each of hundreds of connections): a sender
    # past the read budget is not read until it frees up, and every reservation is returned.
    old = R.Limits.reading, R.Limits.stall
    R.Limits.reading, R.Limits.stall = 3 * R.Limits.read_cost * 300 * 1024, 2.0
    peak_read = [0]
    reserve = R.Peer.reserve
    async def watching(self, n):
        await reserve(self, n)
        peak_read[0] = max(peak_read[0], R.Peer.reading)
    R.Peer.reserve = watching
    rr_, ra_ = room_for(b"read budget")
    readers = [await Client.open(port) for _ in range(8)]
    for c in readers:
        await c.join(rr_, ra_)
    msg = json.dumps({"t": "m", "d": "r" * (300 * 1024 - 100)}).encode()
    async def burst(c):
        for _ in range(4):
            c.frame(msg)
            await c.writer.drain()
    await asyncio.wait_for(asyncio.gather(*(burst(c) for c in readers)), 60)
    await asyncio.sleep(1.0)
    R.Peer.reserve = reserve
    assert 0 < peak_read[0] <= R.Limits.reading + R.Limits.read_cost * 300 * 1024, "read reservations stay within the budget (%d)" % peak_read[0]
    for c in readers:
        c.writer.close()
    await asyncio.sleep(.5)
    assert R.Peer.reading == 0, "every reservation is returned (%d)" % R.Peer.reading
    R.Limits.reading, R.Limits.stall = old

    # Each join is a new identity to the room's editors: one address adds a bounded number.
    old = R.Limits.room_joins
    R.Limits.room_joins = 2
    jr, ja = room_for(b"room joins")
    first = await Client.open(port)
    assert (await first.join(jr, ja, own="room-joins-owner-0123456789"))["owner"] is True
    for _ in range(2):
        assert (await (await Client.open(port)).join(jr, ja))["t"] == "joined"
    third = await Client.open(port)
    await third.send({"t": "join", "room": jr, "auth": ja, "v": 2})
    assert "Too many joins into this session" in (await third.next("error"))["e"]
    assert (await (await Client.open(port)).join(jr, ja, own="room-joins-owner-0123456789"))["owner"] is True, "the room's owner may rejoin"
    R.Limits.room_joins = old

    # An IPv6 subscriber's /64 is one address for the per-address limits.
    class W:
        def __init__(self, addr): self.addr = addr
        def get_extra_info(self, key): return (self.addr, 1)
    assert relay.address(W("2001:db8:1:2::5"), {}) == relay.address(W("2001:db8:1:2:ffff::9"), {}) == "2001:db8:1:2::/64"
    assert relay.address(W("::ffff:192.0.2.7"), {}) == "192.0.2.7" and relay.address(W("192.0.2.7"), {}) == "192.0.2.7"

    # Room capacity; the room's owner can still join its full room.
    old = R.Limits.peers
    R.Limits.peers = 2
    c3 = await Client.open(port)
    await c3.send({"t": "join", "room": room, "auth": auth})
    m = await c3.next("error")
    assert m["t"] == "error" and "full" in m["e"], m
    own = await Client.open(port)
    assert (await own.join(room, auth, own="host-owner-token-0123456789"))["t"] == "joined", "the owner is admitted"
    R.Limits.peers = old

    # Joins per address per minute.
    old = R.Limits.joins
    R.Limits.joins = len(relay.joins["127.0.0.1"]) + 1
    ok_join, refused = await Client.open(port), await Client.open(port)
    assert (await ok_join.join(other_room, other_auth))["t"] == "joined"
    await refused.send({"t": "join", "room": other_room, "auth": other_auth})
    assert "Too many joins" in (await refused.next("error"))["e"]
    R.Limits.joins = old

    # Leaving tells the others which connection left; an empty room is forgotten.
    b.writer.close()
    m = await a.next("peer")
    while m.get("joined"):
        m = await a.next("peer")
    assert m == {"t": "peer", "id": jb["id"], "joined": False}, m
    for client in (x, ok_join):
        client.writer.close()
    await asyncio.sleep(.2)
    assert other_room not in relay.rooms
    task.cancel()

    # --dev serves the editor and sends /join there (the fragment survives the redirect), inside app/ only.
    dev = R.Relay(quiet=True, app=ROOT / "app")
    port_box, started = [], asyncio.Event()
    devtask = asyncio.create_task(R.run("127.0.0.1", 0, quiet=True, relay=dev, ready=lambda p: (port_box.append(p), started.set())))
    await started.wait()
    head, body = await http(port_box[0], "/join")
    assert head.startswith("HTTP/1.1 302") and "Location: /app/index.html" in head
    head, body = await http(port_box[0], "/app/index.html")
    assert head.startswith("HTTP/1.1 200") and b"<html" in body.lower()
    for evil in ("/app/../collab/relay/waffle_relay.py", "/app/%2e%2e/LICENSE", "/app/", "/app/../../etc/passwd"):
        assert (await http(port_box[0], evil))[0].startswith("HTTP/1.1 404"), evil
    head, body = await http(port_box[0], "/healthz")
    assert json.loads(body)["turn"] is False
    devtask.cancel()

    # TURN quotas: a room gets a bounded number of credentials per hour, and a turn-off file (the
    # server's monthly cap) stops them; sessions then use direct and relay paths.
    import tempfile
    with tempfile.TemporaryDirectory() as tmp:
        off = os.path.join(tmp, "turn-off")
        quota = R.Relay(quiet=True, turn=R.Turn(secret, "turn.example.org"), turn_off_file=off)
        port_box, started = [], asyncio.Event()
        qtask = asyncio.create_task(R.run("127.0.0.1", 0, quiet=True, relay=quota, ready=lambda p: (port_box.append(p), started.set())))
        await started.wait()
        old = R.Limits.turn_per_room
        R.Limits.turn_per_room = 3
        qr, qa = room_for(b"quota")
        h = await Client.open(port_box[0]); jh = await h.join(qr, qa, own="quota-owner-token-0123456789")
        guests = []
        for n in range(3):
            g = await Client.open(port_box[0]); jg = await g.join(qr, qa); guests.append((g, jg))
            await h.send({"t": "attest", "id": jg["id"]})
        got = 0
        for c in [h] + [g for g, _ in guests]:
            got += (await c.nothing(.3, ignore=("peers", "peer", "m"))) is not None
        assert got == 3, "the room's hourly TURN budget is respected (%d)" % got
        R.Limits.turn_per_room = old
        assert json.loads((await http(port_box[0], "/healthz"))[1])["turn"] is True
        open(off, "w").close()
        assert json.loads((await http(port_box[0], "/healthz"))[1])["turn"] is False, "past the monthly cap TURN is off"
        q2r, q2a = room_for(b"quota 2")
        h2 = await Client.open(port_box[0]); await h2.join(q2r, q2a, own="quota-owner-token-abcdefghijk")
        g2 = await Client.open(port_box[0]); jg2 = await g2.join(q2r, q2a)
        await h2.send({"t": "attest", "id": jg2["id"]})
        assert await g2.nothing() is None and await h2.nothing() is None, "no TURN while it is switched off"
        await g2.send({"t": "m", "d": "still works"})
        assert (await h2.next("m"))["d"] == "still works", "the relay path still works"
        # Rooms per address.
        old = R.Limits.rooms_per_address
        R.Limits.rooms_per_address = len([m for m in quota.rooms.values() if m["by"] == "127.0.0.1"])
        extra = await Client.open(port_box[0]); er, ea = room_for(b"one too many")
        await extra.send({"t": "join", "room": er, "auth": ea, "v": 2})
        assert "Too many sessions" in (await extra.next("error"))["e"]
        R.Limits.rooms_per_address = old
        qtask.cancel()

        # Private mode: only invited hosts open sessions; guests join with the link alone.
        hosts = os.path.join(tmp, "hosts")
        open(hosts, "w").write(hashlib.sha256(b"alice-host-token").hexdigest() + " Alice\n")
        private = R.Relay(quiet=True, hosts_file=hosts)
        port_box, started = [], asyncio.Event()
        ptask = asyncio.create_task(R.run("127.0.0.1", 0, quiet=True, relay=private, ready=lambda p: (port_box.append(p), started.set())))
        await started.wait()
        pr, pa = room_for(b"private")
        stranger = await Client.open(port_box[0])
        await stranger.send({"t": "join", "room": pr, "auth": pa, "v": 2, "host": "guessing"})
        assert "private" in (await stranger.next("error"))["e"]
        alice = await Client.open(port_box[0])
        assert (await alice.join(pr, pa, own="alice-owner-token-0123456789", host="alice-host-token"))["owner"] is True
        guest = await Client.open(port_box[0])
        assert (await guest.join(pr, pa))["t"] == "joined", "a guest needs only the session link"
        open(hosts, "w").write("")
        private.reload()   # what SIGHUP does (waffle-collab remove-host)
        revoked = await Client.open(port_box[0]); rr, ra = room_for(b"revoked")
        await revoked.send({"t": "join", "room": rr, "auth": ra, "v": 2, "host": "alice-host-token"})
        assert "private" in (await revoked.next("error"))["e"], "a removed host can no longer open sessions"
        assert json.loads((await http(port_box[0], "/healthz"))[1])["mode"] == "private"
        ptask.cancel()
    print("collab-relay: ok (join token, room isolation, addressed messages, signalling, no echo, framing, "
          "rate slowing, per-peer queues, memory and read budgets, joins per room, room, owner and address limits, IPv6 /64, vouched TURN, TURN quotas and off switch, private hosts, /healthz, /join, --dev)")


if __name__ == "__main__":
    asyncio.run(main())
