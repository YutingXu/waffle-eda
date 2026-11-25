#!/usr/bin/env python3
"""Waffle collaboration relay: signalling, fallback relaying and TURN credentials for live sessions.

Editors in one room meet here. The relay introduces them (WebRTC offers, answers and candidates,
sealed with the room key so the relay cannot read them), forwards their end-to-end encrypted
messages when no direct or TURN data channel works, and hands each joining editor short-lived
TURN credentials (coturn's use-auth-secret REST scheme). It never sees a room key, a project or a
cursor: clients encrypt with AES-256-GCM under a key derived from the room key they share out of
band (app/collab-transport.js), and the relay only checks that a joining connection knows the
room's join token (SHA-256(token) == room id). It stores nothing and logs no content.

Python 3.8+ standard library only.

    python3 collab/relay/waffle_relay.py --dev                # 127.0.0.1:8765, also serves app/ to try it
    python3 collab/relay/waffle_relay.py --host 0.0.0.0       # the local network (ws://)
    python3 collab/relay/waffle_relay.py --cert c.pem --key k.pem   # wss:// without a proxy
    # behind Caddy (deploy/collab-server): --trust-proxy --turn-host DOMAIN --turn-secret-file FILE

HTTP: GET /healthz (JSON status), GET /join (the invitation landing page; the invitation itself
stays in the URL fragment, which browsers never send). Anything else that asks for a WebSocket
upgrade is the relay.

Protocol (JSON text frames):
  client: {t:"join", room, auth, v:2, own?, host?}   own: an owner token; the room's first joiner sets it.
          host: a personal host token, needed to open a room only on a private relay (--hosts-file);
          joining an existing room never needs one: guests only need the session link.
  relay:  {t:"joined", ..., owner: bool}
  owner:  {t:"attest", id}   the room's owner (its host) vouches that this connection proved it holds
          the room key (collab-transport.js); TURN credentials go only to vouched members.
  relay:  {t:"joined", v:2, id, peers:[ids], ice:[RTCIceServer], ttl} | {t:"error", e}
  relay:  {t:"peer", id, joined:true|false}, {t:"peers", n} (v1 editors)
  client: {t:"m", d, to?:[ids]}          ->  others: {t:"m", d, from}
  client: {t:"sig", to:id, d}            ->  that peer: {t:"sig", from, d}
  client: {t:"ice"} -> {t:"ice", ice, ttl};  {t:"p"}: keepalive, ignored

Limits (class Limits): message size, peers per room, rooms, connections overall and per address
(an IPv6 /64 counts as one address), joins per address per minute, per-connection rate (a fast
sender is slowed down, not cut off, so a host sending its project to several guests is never shut
out of its own room) and memory: each peer's outgoing queue is bounded, a sender stops being read
while a recipient is behind, a recipient that stays behind is disconnected, and all queues share
one budget. Rooms idle for two hours are closed.

TURN is the costly part, so it is rationed instead of locked: credentials (1 hour) go only to
members the room's host has vouched for once they proved they hold the room key, and only while
two such members are present; each room and each address get a bounded number per hour; and the
server can switch TURN off (--turn-off-file, e.g. at a monthly bandwidth cap) so sessions fall
back to direct and relay paths. STUN is always offered.

See collab/relay/README.md, deploy/collab-server/ and docs/collaboration.md (threat model).
"""
import argparse
import asyncio
import base64
import collections
import hashlib
import hmac
import ipaddress
import json
import mimetypes
import os
from pathlib import Path
import re
import secrets
import ssl
import struct
import sys
import time

GUID = b"258EAFA5-E914-47DA-95CA-C5AB0DC85B11"
HEX64 = re.compile(r"[0-9a-f]{64}\Z")
CID = re.compile(r"c[0-9a-f]{16}\Z")
VERSION = 2


class Limits:
    frame = 1024 * 1024              # one WebSocket message (clients chunk larger bodies)
    signal = 64 * 1024               # one signalling message
    rooms = 256                      # rooms at once
    peers = 16                       # connections per room (the room's owner may still join a full room)
    connections = 512                # connections at once
    per_address = 32                 # connections from one address
    joins = 60                       # joins per address per minute
    join_timeout = 10.0              # seconds to send a join
    idle = 600.0                     # seconds without a message before a connection is closed
    rate_messages = 400              # messages per window per connection, then the sender waits
    rate_bytes = 24 * 1024 * 1024    # bytes per window per connection, then the sender waits
    rate_window = 10.0               # seconds
    queue = 6 * 1024 * 1024          # bytes waiting for one peer; beyond that the peer is too slow
    queue_soft = 3 * 1024 * 1024     # past this, senders to that peer wait (stop being read)
    queue_total = 128 * 1024 * 1024  # all peers' queues together; past this every sender waits
    stall = 5.0                      # seconds a recipient may stay behind before it is disconnected
    ice_every = 30.0                 # seconds between TURN credential refreshes per connection
    rooms_per_address = 8            # rooms one address (IPv6 /64) may have open
    turn_per_room = 40               # TURN credentials per room per hour
    turn_per_address = 60            # TURN credentials per address per hour
    room_idle = 2 * 3600.0           # seconds without a forwarded message before a room is closed
    room_joins = 20                  # joins into one room per address per 10 minutes (new identities)
    reading = 160 * 1024 * 1024      # bytes reserved by messages being read and forwarded, all connections
    read_cost = 8                    # reserved per received byte: the frame, its unmasked copy, text, JSON, the frame out
    read_wait = 20.0                 # seconds a sender may wait for that budget before it is disconnected


def unmask(data, mask):
    n = len(data)
    if not n:
        return b""
    key = (mask * (n // 4 + 1))[:n]
    return (int.from_bytes(data, "big") ^ int.from_bytes(key, "big")).to_bytes(n, "big")


def frame(op, payload):
    n = len(payload)
    head = bytes([0x80 | op]) + (bytes([n]) if n < 126 else bytes([126]) + struct.pack("!H", n) if n < 65536 else bytes([127]) + struct.pack("!Q", n))
    return head + payload


class Closed(Exception):
    pass


class Peer:
    """One WebSocket connection. Outgoing frames go through its own queue and writer task."""
    total = 0     # bytes queued for all peers (Limits.queue_total)
    reading = 0   # bytes reserved by messages being read and forwarded (Limits.reading)

    def __init__(self, reader, writer, address):
        self.reader, self.writer, self.address = reader, writer, address
        self.id = "c" + secrets.token_hex(8)
        self.room = None
        self.owner = False
        self.window, self.count, self.bytes = time.monotonic(), 0, 0
        self.out = collections.deque()
        self.queued = 0
        self.wake = asyncio.Event()
        self.drained = asyncio.Event()
        self.has_turn = False
        self.attested = False
        self.closing = False
        self.ice_at = 0.0
        self.task = None
        self.held = 0

    async def read_exact(self, n):
        try:
            return await self.reader.readexactly(n)
        except (asyncio.IncompleteReadError, ConnectionError):
            raise Closed() from None

    async def reserve(self, n):
        """Reserve memory for n more received bytes before reading them (relay memory: every
        connection's message in flight counts, not only the queues). Waits while the relay is full;
        a message can always go through when nothing else is reserved."""
        cost = n * Limits.read_cost
        deadline = time.monotonic() + Limits.read_wait
        while Peer.reading - self.held > 0 and Peer.reading + cost > Limits.reading:
            if time.monotonic() > deadline:
                self.abort(1013)
                raise Closed()
            await asyncio.sleep(0.02)
        self.held += cost
        Peer.reading += cost

    def release(self):
        """The message read so far has been handled (forwarded or dropped)."""
        Peer.reading -= self.held
        self.held = 0

    async def recv(self):
        """One text message (fragments joined; pings answered). Raises Closed. The caller calls
        release() once it has handled the message."""
        self.release()
        parts, size, opcode = [], 0, None
        while True:
            head = await self.read_exact(2)
            fin, op, masked, length = head[0] & 0x80, head[0] & 0x0F, head[1] & 0x80, head[1] & 0x7F
            if head[0] & 0x70 or not masked:
                await self.close(1002)
                raise Closed()
            if length == 126:
                length = struct.unpack("!H", await self.read_exact(2))[0]
            elif length == 127:
                length = struct.unpack("!Q", await self.read_exact(8))[0]
            if length > Limits.frame or size + length > Limits.frame:
                await self.close(1009)
                raise Closed()
            mask = await self.read_exact(4)
            if length > 125:
                await self.reserve(length)
            data = unmask(await self.read_exact(length), mask)
            if op == 0x8:
                await self.close(1000)
                raise Closed()
            if op == 0x9:
                self.push(frame(0xA, bytes(data)))
                continue
            if op == 0xA:
                continue
            if op in (0x1, 0x2):
                if opcode is not None:
                    await self.close(1002)
                    raise Closed()
                opcode = op
            elif op != 0x0 or opcode is None:
                await self.close(1002)
                raise Closed()
            parts.append(bytes(data))
            size += length
            if fin:
                if opcode != 0x1:
                    await self.close(1003)
                    raise Closed()
                try:
                    return b"".join(parts).decode("utf-8")
                except UnicodeDecodeError:
                    await self.close(1007)
                    raise Closed() from None

    def push(self, data):
        """Queue a frame for this peer without waiting. False when the peer is too far behind."""
        if self.closing:
            return False
        if self.queued + len(data) > Limits.queue:
            self.abort(1013)
            return False
        self.out.append(data)
        self.queued += len(data)
        Peer.total += len(data)
        self.wake.set()
        return True

    def abort(self, code):
        """Drop what is queued and close: this peer is too far behind."""
        if self.closing:
            return
        self.closing = True
        Peer.total -= self.queued
        self.out.clear()
        self.queued = 0
        self.out.append(frame(0x8, struct.pack("!H", code)))
        self.wake.set()
        self.drained.set()

    def send(self, obj):
        return self.push(frame(0x1, json.dumps(obj, separators=(",", ":")).encode("utf-8")))

    async def writer_loop(self):
        try:
            while True:
                await self.wake.wait()
                self.wake.clear()
                while self.out:
                    data = self.out.popleft()
                    if not self.closing or data[0] != 0x88:
                        self.queued -= len(data)
                        Peer.total -= len(data)
                    if self.queued <= Limits.queue_soft:
                        self.drained.set()
                    self.writer.write(data)
                    await self.writer.drain()
                    if data[0] == 0x88:
                        raise Closed()
        except (Closed, ConnectionError, RuntimeError, asyncio.CancelledError):
            pass
        finally:
            Peer.total -= self.queued
            self.queued = 0
            self.out.clear()
            self.drained.set()
            try:
                self.writer.close()
            except Exception:
                pass

    async def close(self, code=1000):
        """Send a close frame (after what is queued) and stop."""
        if not self.closing:
            self.closing = True
            self.out.append(frame(0x8, struct.pack("!H", code)))
            self.wake.set()
        if self.task:
            try:
                await asyncio.wait_for(asyncio.shield(self.task), 2.0)
            except (asyncio.TimeoutError, asyncio.CancelledError):
                self.task.cancel()

    async def throttle(self, size):
        """Per-connection rate: past the budget the sender waits for the next window."""
        now = time.monotonic()
        if now - self.window > Limits.rate_window:
            self.window, self.count, self.bytes = now, 0, 0
        self.count += 1
        self.bytes += size
        if self.count > Limits.rate_messages or self.bytes > Limits.rate_bytes:
            await asyncio.sleep(max(0.0, self.window + Limits.rate_window - now))
            self.window, self.count, self.bytes = time.monotonic(), 1, size


class Turn:
    """Short-lived TURN credentials: username "<expiry>:<random>", password base64(HMAC-SHA1(secret, username))."""

    def __init__(self, secret=None, host=None, uris=(), ttl=3600):
        self.secret, self.ttl = secret, ttl
        self.uris = list(uris)
        if host and not self.uris:
            self.uris = ["turn:%s:3478?transport=udp" % host, "turn:%s:3478?transport=tcp" % host, "turns:%s:5349?transport=tcp" % host]
        self.stun = ["stun:%s:3478" % host] if host else []

    def servers(self, turn=True):
        out = [{"urls": self.stun}] if self.stun else []
        if turn and self.secret and self.uris:
            user = "%d:%s" % (int(time.time()) + self.ttl, secrets.token_hex(6))
            password = base64.b64encode(hmac.new(self.secret, user.encode("ascii"), hashlib.sha1).digest()).decode("ascii")
            out.append({"urls": self.uris, "username": user, "credential": password})
        return out


JOIN_PAGE = b"""<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="referrer" content="no-referrer"><title>Waffle live session</title>
<style>:root{color-scheme:light dark;font:16px/1.5 system-ui,sans-serif}body{max-width:36rem;margin:3rem auto;padding:0 1rem}
code,textarea{font:14px ui-monospace,monospace}textarea{width:100%;height:7rem}</style></head><body>
<h1>Waffle live session</h1>
<p>This is a Waffle link: an invitation to edit a design together, or an invitation to host sessions on this server.
In Waffle, choose <b>Share</b> and paste this page's address (or the text below) into the invitation field.</p><textarea id="i" readonly aria-label="Invitation"></textarea>
<p><button type="button" id="c">Copy invitation</button></p>
<p><small>The room key is in the part of the address after <code>#</code>. Your browser keeps it; this server never receives it.</small></p>
<script>const i=document.getElementById("i");i.value=location.href;document.getElementById("c").onclick=()=>{i.select();navigator.clipboard?.writeText(i.value)};</script>
</body></html>
"""


class Relay:
    def __init__(self, quiet=False, turn=None, trust_proxy=False, app=None, hosts_file=None, turn_off_file=None, lan=None):
        self.hosts_file, self.turn_off_file = hosts_file, turn_off_file
        # lan: one session shared on the local network by the Waffle app (native/linux/lan_relay.py):
        # {"room", "salt", "name", "host"}. Only that room may be joined, and before joining anyone may
        # ask {"t": "info"} for its public facts (the session salt, its display name, the host's peer
        # id): a guest who found it on the network or typed its address then needs only the short code.
        self.lan = lan
        self.hosts = {}
        self.turn_log = collections.defaultdict(collections.deque)   # address -> times of TURN credentials
        self.reload()
        self.rooms = {}
        self.connections = 0
        self.by_address = collections.Counter()
        self.joins = collections.defaultdict(collections.deque)
        self.room_joins = collections.defaultdict(collections.deque)
        self.quiet = quiet
        self.turn = turn or Turn()
        self.trust_proxy = trust_proxy
        self.app = Path(app).resolve() if app else None

    def reload(self):
        """Private mode: the hosts file holds "sha256(token) name" per line (waffle-collab add-host). SIGHUP reloads it."""
        hosts = {}
        if self.hosts_file:
            try:
                for line in Path(self.hosts_file).read_text().splitlines():
                    parts = line.split(None, 1)
                    if parts and HEX64.match(parts[0]):
                        hosts[parts[0]] = parts[1].strip() if len(parts) > 1 else ""
            except OSError as e:
                print("hosts file: %s" % e, file=sys.stderr, flush=True)
        self.hosts = hosts

    @property
    def private(self):
        return self.hosts_file is not None

    def turn_on(self):
        return bool(self.turn.secret and self.turn.uris) and not (self.turn_off_file and os.path.exists(self.turn_off_file))

    def grant_turn(self, room, members, peer, refresh=False):
        """TURN credentials for a vouched member while two vouched members are here, within budgets."""
        if not self.turn_on() or not peer.attested or (peer.has_turn and not refresh):
            return False
        if sum(1 for p in members["peers"].values() if p.attested) < 2:
            return False
        now = time.monotonic()
        for log, cap in ((members["turn"], Limits.turn_per_room), (self.turn_log[peer.address], Limits.turn_per_address)):
            while log and now - log[0] > 3600:
                log.popleft()
            if len(log) >= cap:
                return False
        members["turn"].append(now)
        self.turn_log[peer.address].append(now)
        peer.has_turn = True
        peer.ice_at = now
        peer.send({"t": "ice", "ice": self.turn.servers(), "ttl": self.turn.ttl})
        return True

    def log(self, text):
        if not self.quiet:
            print(time.strftime("%H:%M:%S"), text, flush=True)

    # ---- HTTP ----------------------------------------------------------------------------------------
    def respond(self, writer, status, body=b"", kind="text/plain; charset=utf-8", extra=""):
        head = ("HTTP/1.1 %s\r\nContent-Type: %s\r\nContent-Length: %d\r\nCache-Control: no-store\r\nX-Content-Type-Options: nosniff\r\n"
                "Referrer-Policy: no-referrer\r\nConnection: close\r\n%s\r\n") % (status, kind, len(body), extra)
        writer.write(head.encode("latin-1") + body)

    def http(self, writer, path):
        path = path.split("?", 1)[0]
        if path == "/healthz":
            body = json.dumps({"ok": True, "version": VERSION, "turn": self.turn_on(), "mode": "private" if self.private else "open"}).encode()
            # Public facts only; Preferences › Test Connection reads them from the editor's own origin.
            return self.respond(writer, "200 OK", body, "application/json", "Access-Control-Allow-Origin: *\r\n")
        if path in ("/join", "/join/", "/host", "/host/"):
            if self.app:   # --dev: the editor itself is served here; the fragment survives the redirect
                return self.respond(writer, "302 Found", extra="Location: /app/index.html\r\n")
            return self.respond(writer, "200 OK", JOIN_PAGE, "text/html; charset=utf-8",
                                "Content-Security-Policy: default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'\r\n")
        if self.app and (path == "/" or path.startswith("/app/")):
            if path == "/":
                return self.respond(writer, "302 Found", extra="Location: /app/index.html\r\n")
            target = (self.app / path[len("/app/"):]).resolve()
            if target == self.app or self.app not in target.parents or not target.is_file():
                return self.respond(writer, "404 Not Found", b"not found")
            kind = mimetypes.guess_type(str(target))[0] or "application/octet-stream"
            if kind.startswith("text/") or kind in ("application/javascript", "application/json"):
                kind += "; charset=utf-8"
            return self.respond(writer, "200 OK", target.read_bytes(), kind)
        return self.respond(writer, "426 Upgrade Required" if path in ("/", "/ws") else "404 Not Found", b"")

    async def request(self, reader, writer):
        """Reads one request head. Returns (path, headers) or None."""
        try:
            head = await asyncio.wait_for(reader.readuntil(b"\r\n\r\n"), Limits.join_timeout)
        except (asyncio.TimeoutError, asyncio.IncompleteReadError, asyncio.LimitOverrunError, ConnectionError):
            return None
        lines = head.decode("latin-1").split("\r\n")
        m = re.match(r"GET (/[^\s]*) HTTP/1\.1\Z", lines[0])
        if not m:
            self.respond(writer, "400 Bad Request")
            return None
        headers = {}
        for line in lines[1:]:
            if ":" in line:
                k, v = line.split(":", 1)
                headers[k.strip().lower()] = v.strip()
        return m.group(1), headers

    def address(self, writer, headers):
        peer = writer.get_extra_info("peername")
        addr = peer[0] if isinstance(peer, tuple) else "local"
        if self.trust_proxy and headers.get("x-forwarded-for"):
            try:
                if ipaddress.ip_address(addr).is_loopback:
                    addr = headers["x-forwarded-for"].split(",")[-1].strip() or addr
            except ValueError:
                pass
        # One IPv6 subscriber usually holds a whole /64: count it as one address.
        try:
            ip = ipaddress.ip_address(addr)
            if ip.version == 6:
                return str(ip.ipv4_mapped or ipaddress.ip_network(addr + "/64", strict=False))
            return str(ip)
        except ValueError:
            return addr

    def may_join_room(self, room, addr):
        """Each join is a new identity to the room's editors (they allow a bounded number of
        authors): limit how fast one address adds them."""
        now, window = time.monotonic(), self.room_joins[(room, addr)]
        while window and now - window[0] > 600:
            window.popleft()
        if len(window) >= Limits.room_joins:
            return False
        window.append(now)
        if len(self.room_joins) > 4 * Limits.connections:
            for k in [k for k, w in self.room_joins.items() if not w or now - w[-1] > 600]:
                del self.room_joins[k]
        return True

    def may_join(self, addr):
        now, window = time.monotonic(), self.joins[addr]
        while window and now - window[0] > 60:
            window.popleft()
        if len(window) >= Limits.joins:
            return False
        window.append(now)
        return True

    # ---- the relay -----------------------------------------------------------------------------------
    async def serve(self, reader, writer):
        if self.connections >= Limits.connections:
            writer.close()
            return
        self.connections += 1
        peer, addr = None, None
        try:
            got = await self.request(reader, writer)
            if not got:
                return
            path, headers = got
            key = headers.get("sec-websocket-key", "")
            if headers.get("upgrade", "").lower() != "websocket" or "upgrade" not in headers.get("connection", "").lower() or not key:
                self.http(writer, path)
                await writer.drain()
                return
            addr = self.address(writer, headers)
            if self.by_address[addr] >= Limits.per_address:
                self.respond(writer, "429 Too Many Requests")
                await writer.drain()
                addr = None
                return
            self.by_address[addr] += 1
            accept = base64.b64encode(hashlib.sha1(key.encode("ascii", "replace") + GUID).digest()).decode("ascii")
            writer.write(("HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n"
                          "Sec-WebSocket-Accept: " + accept + "\r\n\r\n").encode("ascii"))
            await writer.drain()
            peer = Peer(reader, writer, addr)
            peer.task = asyncio.ensure_future(peer.writer_loop())
            await self.session(peer)
        except Closed:
            pass
        except (ConnectionError, asyncio.CancelledError):
            pass
        finally:
            self.connections -= 1
            if addr is not None:
                self.by_address[addr] -= 1
                if self.by_address[addr] <= 0:
                    del self.by_address[addr]
            if peer is not None:
                peer.release()
                self.leave(peer)
                if not peer.closing:
                    await peer.close(1000)
                elif peer.task:
                    try:
                        await asyncio.wait_for(asyncio.shield(peer.task), 2.0)
                    except (asyncio.TimeoutError, asyncio.CancelledError):
                        peer.task.cancel()
            else:
                try:
                    writer.close()
                except Exception:
                    pass

    async def session(self, peer):
        # The first message must be a join with the room id and its token.
        try:
            join = json.loads(await asyncio.wait_for(peer.recv(), Limits.join_timeout))
            if self.lan and isinstance(join, dict) and join.get("t") == "info":
                peer.send({"t": "info", "v": VERSION, "salt": self.lan.get("salt"), "name": self.lan.get("name"), "host": self.lan.get("host")})
                join = json.loads(await asyncio.wait_for(peer.recv(), Limits.join_timeout))
        except (asyncio.TimeoutError, ValueError):
            await peer.close(1008)
            return
        if not isinstance(join, dict):
            join = {}
        room, auth, own = join.get("room"), join.get("auth"), join.get("own")
        if join.get("t") != "join" or not isinstance(room, str) or not isinstance(auth, str) or not HEX64.match(room) or not HEX64.match(auth) \
                or hashlib.sha256(bytes.fromhex(auth)).hexdigest() != room:
            peer.send({"t": "error", "e": "The room key does not match this room."})
            await peer.close(1008)
            return
        if self.lan and room != self.lan.get("room"):
            peer.send({"t": "error", "e": "This Waffle session is not shared here any more."})
            await peer.close(1008)
            return
        if not self.may_join(peer.address):
            peer.send({"t": "error", "e": "Too many joins from this address; try again in a minute."})
            await peer.close(1008)
            return
        owner = hashlib.sha256(own.encode("utf-8")).hexdigest() if isinstance(own, str) and 16 <= len(own) <= 128 else None
        members = self.rooms.get(room)
        if members is not None and not (owner is not None and members["owner"] == owner) and not self.may_join_room(room, peer.address):
            peer.send({"t": "error", "e": "Too many joins into this session from this address; try again in a few minutes."})
            await peer.close(1008)
            return
        if members is None and len(self.rooms) >= Limits.rooms:
            peer.send({"t": "error", "e": "The relay is full."})
            await peer.close(1013)
            return
        if members is None and self.private:
            token = join.get("host")
            digest = hashlib.sha256(token.encode("utf-8")).hexdigest() if isinstance(token, str) and len(token) <= 200 else ""
            if not any(hmac.compare_digest(digest, h) for h in self.hosts):
                peer.send({"t": "error", "e": "This relay is private: only invited hosts can start sessions on it. Ask its owner for a host invitation (joining someone's session needs only their link)."})
                await peer.close(1008)
                return
        if members is None and sum(1 for m in self.rooms.values() if m["by"] == peer.address) >= Limits.rooms_per_address:
            peer.send({"t": "error", "e": "Too many sessions from this address."})
            await peer.close(1013)
            return
        is_owner = members is not None and owner is not None and members["owner"] == owner
        if members is not None and len(members["peers"]) >= Limits.peers + (2 if is_owner else 0):
            peer.send({"t": "error", "e": "This room is full."})
            await peer.close(1013)
            return
        if members is None:
            members = self.rooms[room] = {"peers": {}, "owner": owner, "by": peer.address, "turn": collections.deque(), "active": time.monotonic()}
            is_owner = owner is not None
        peer.owner = peer.attested = is_owner
        others = list(members["peers"].values())
        members["peers"][peer.id] = peer
        peer.room = room
        self.log("join room %s… (%d in room)" % (room[:8], len(members["peers"])))
        peer.ice_at = time.monotonic()
        # STUN now; TURN later, once the host vouches for this member (grant_turn).
        peer.send({"t": "joined", "v": VERSION, "id": peer.id, "peers": [p.id for p in others], "ice": self.turn.servers(turn=False),
                   "ttl": self.turn.ttl, "owner": is_owner})
        for other in others:
            other.send({"t": "peer", "id": peer.id, "joined": True})
            other.send({"t": "peers", "n": len(members["peers"]) - 1})
        while True:
            try:
                text = await asyncio.wait_for(peer.recv(), Limits.idle)
            except asyncio.TimeoutError:
                await peer.close(1001)
                return
            if peer.closing:
                return
            await peer.throttle(len(text))
            try:
                msg = json.loads(text)
            except ValueError:
                continue
            if not isinstance(msg, dict):
                continue
            kind = msg.get("t")
            if kind == "m" and isinstance(msg.get("d"), str):
                to = msg.get("to")
                out = {"t": "m", "d": msg["d"], "from": peer.id}
                peers = members["peers"]
                if isinstance(to, list):
                    targets = [peers[c] for c in to[:64] if isinstance(c, str) and c in peers and c != peer.id]
                else:
                    targets = [p for p in peers.values() if p is not peer]
                members["active"] = time.monotonic()
                if targets:
                    data = frame(0x1, json.dumps(out, separators=(",", ":")).encode("utf-8"))
                    await self.room_for(peer, len(data) * len(targets))
                    for other in targets:
                        other.push(data)   # each peer has its own queue
                    await self.backpressure(peer, targets)
                peer.release()
            elif kind == "sig" and isinstance(msg.get("d"), str) and len(msg["d"]) <= Limits.signal and isinstance(msg.get("to"), str):
                other = members["peers"].get(msg["to"])
                if other is not None and other is not peer:
                    members["active"] = time.monotonic()
                    other.send({"t": "sig", "from": peer.id, "d": msg["d"]})
            elif kind == "attest" and peer.owner and isinstance(msg.get("id"), str):
                other = members["peers"].get(msg["id"])
                if other is not None and not other.attested:
                    other.attested = True
                    for member in list(members["peers"].values()):
                        self.grant_turn(room, members, member)
            elif kind == "ice" and peer.has_turn and time.monotonic() - peer.ice_at >= Limits.ice_every:
                self.grant_turn(room, members, peer, refresh=True)

    async def room_for(self, sender, size):
        """Wait (bounded) until the queues have room for size more bytes: checked before queueing."""
        deadline = time.monotonic() + 2 * Limits.stall
        while Peer.total and Peer.total + size > Limits.queue_total and not sender.closing:
            if time.monotonic() > deadline:
                sender.abort(1013)
                raise Closed()
            await asyncio.sleep(0.05)

    async def backpressure(self, sender, targets):
        """Stop reading from a sender while a recipient is behind (bounded memory). A recipient that
        stays behind for Limits.stall is disconnected, so it cannot hold the room back for long."""
        deadline = time.monotonic() + Limits.stall
        for other in targets:
            while other.queued > Limits.queue_soft and not other.closing:
                left = deadline - time.monotonic()
                if left <= 0:
                    other.abort(1013)
                    break
                other.drained.clear()
                try:
                    await asyncio.wait_for(other.drained.wait(), left)
                except asyncio.TimeoutError:
                    pass
        while Peer.total > Limits.queue_total and not sender.closing:
            if time.monotonic() > deadline + Limits.stall:
                sender.abort(1013)
                raise Closed()
            await asyncio.sleep(0.05)

    async def sweep(self):
        """Close rooms with no forwarded message for Limits.room_idle (keepalives alone don't count)."""
        while True:
            await asyncio.sleep(60)
            now = time.monotonic()
            for room, members in list(self.rooms.items()):
                if now - members["active"] > Limits.room_idle:
                    for member in list(members["peers"].values()):
                        member.abort(1001)

    def leave(self, peer):
        if peer.room is None:
            return
        members = self.rooms.get(peer.room)
        room, peer.room = peer.room, None
        if not members:
            return
        members["peers"].pop(peer.id, None)
        if members["peers"]:
            for other in members["peers"].values():
                other.send({"t": "peer", "id": peer.id, "joined": False})
                other.send({"t": "peers", "n": len(members["peers"]) - 1})
        else:
            self.rooms.pop(room, None)
        self.log("leave room %s… (%d left)" % (room[:8], len(members["peers"])))


async def run(host, port, context=None, quiet=False, ready=None, turn=None, trust_proxy=False, app=None, relay=None, hosts_file=None, turn_off_file=None):
    relay = relay or Relay(quiet=quiet, turn=turn, trust_proxy=trust_proxy, app=app, hosts_file=hosts_file, turn_off_file=turn_off_file)
    try:
        import signal
        asyncio.get_running_loop().add_signal_handler(signal.SIGHUP, relay.reload)
    except (ImportError, NotImplementedError, RuntimeError, AttributeError):
        pass
    sweeper = asyncio.ensure_future(relay.sweep())
    server = await asyncio.start_server(relay.serve, host, port, ssl=context, limit=64 * 1024)
    bound = server.sockets[0].getsockname()
    scheme = "wss" if context else "ws"
    print("Waffle relay %d on %s://%s:%d (rooms are end-to-end encrypted; TURN %s; %s; Ctrl+C to stop)"
          % (VERSION, scheme, bound[0], bound[1], "on" if relay.turn.secret else "off", "private: invited hosts only" if relay.private else "open"), flush=True)
    if relay.app:
        print("Development mode: open http://%s:%d/app/index.html in two browser windows, then Share › Start in one,\n"
              "copy the invitation link and open it in the other. Relay address: %s://%s:%d" % (bound[0], bound[1], scheme, bound[0], bound[1]), flush=True)
    if ready:
        ready(bound[1])
    try:
        async with server:
            await server.serve_forever()
    finally:
        sweeper.cancel()


def read_secret(path):
    data = Path(path).read_bytes().strip()
    if len(data) < 16:
        raise SystemExit("The TURN secret in %s is too short." % path)
    return data


def main(argv=None):
    parser = argparse.ArgumentParser(description="Waffle collaboration relay: signalling, fallback relaying and TURN credentials.")
    parser.add_argument("--host", default="127.0.0.1", help="address to listen on (0.0.0.0 for the local network)")
    parser.add_argument("--port", type=int, default=8765)
    parser.add_argument("--cert", help="TLS certificate (PEM) for wss://")
    parser.add_argument("--key", help="TLS private key (PEM)")
    parser.add_argument("--quiet", action="store_true", help="no join/leave lines")
    parser.add_argument("--dev", action="store_true", help="local testing: also serve the editor (app/) at /app/ and send /join there")
    parser.add_argument("--app", help="serve this editor directory at /app/ (implied by --dev)")
    parser.add_argument("--trust-proxy", action="store_true", help="behind a local reverse proxy: rate-limit by X-Forwarded-For")
    parser.add_argument("--turn-host", help="TURN/STUN host name handed to editors (coturn on the same server)")
    parser.add_argument("--turn-uri", action="append", default=[], help="a TURN URI instead of the --turn-host defaults (repeatable)")
    parser.add_argument("--turn-secret-file", help="coturn's static-auth-secret (use-auth-secret); credentials are minted per join")
    parser.add_argument("--turn-ttl", type=int, default=3600, help="TURN credential lifetime in seconds")
    parser.add_argument("--hosts-file", help="private mode: only hosts listed here (sha256 of their token, then a name) may start sessions")
    parser.add_argument("--turn-off-file", help="while this file exists, no TURN credentials are issued (e.g. a monthly bandwidth cap)")
    args = parser.parse_args(argv)
    context = None
    if args.cert:
        context = ssl.SSLContext(ssl.PROTOCOL_TLS_SERVER)
        context.minimum_version = ssl.TLSVersion.TLSv1_2
        context.load_cert_chain(args.cert, args.key)
    secret_file = args.turn_secret_file
    if secret_file and "$CREDENTIALS_DIRECTORY" in secret_file:
        secret_file = secret_file.replace("$CREDENTIALS_DIRECTORY", os.environ.get("CREDENTIALS_DIRECTORY", ""))
    turn = Turn(read_secret(secret_file) if secret_file else None, args.turn_host, args.turn_uri, args.turn_ttl)

    app = args.app or (str(Path(__file__).resolve().parents[2] / "app") if args.dev else None)
    try:
        asyncio.run(run(args.host, args.port, context, args.quiet, turn=turn, trust_proxy=args.trust_proxy, app=app,
                        hosts_file=args.hosts_file, turn_off_file=args.turn_off_file))
    except KeyboardInterrupt:
        pass
    return 0


if __name__ == "__main__":
    sys.exit(main())
