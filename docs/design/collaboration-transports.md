# Connection options for Waffle live sessions

Transport design, 20 November 2026

**Waffle uses a self-hosted relay for introductions and fallback, WebRTC data channels between editors, and TURN on the same server for networks that block direct connections.** The relay server is a user setting, never built in. Invitations are links whose room key stays in the URL fragment. Every path carries the same end-to-end encrypted messages. [How to use it](../collaboration.md#live-sessions-prototype) · [Server kit](../../deploy/collab-server/README.md)

## Why not Tailcat

The first trial bundled Tailcat (v0.7.0) and a Go helper per platform. It worked, but it put a native binary, a Go toolchain, per-platform signing and third-party notices into every release; it depended on public DERP relays unless a team ran its own; and browsers could not use it. The review removed it.

## The design

| Piece | Role |
|---|---|
| Relay (`collab/relay/waffle_relay.py`) | WebSocket rendezvous: room admission by join token, sealed WebRTC signalling between named connections, fallback forwarding of sealed messages, per-join TURN credentials, rate limits that slow rather than cut off, per-peer send queues. Python standard library only. |
| WebRTC data channel per pair of editors | One negotiated, ordered, reliable channel (`id: 0`). Frames are split to the channel's message size (64 KiB at most) and each link has its own queue with `bufferedAmount` backpressure. |
| TURN (coturn) beside the relay | `use-auth-secret`: the relay mints `<expiry>:<random>` usernames with HMAC-SHA1 passwords per join; the secret never leaves the server. UDP and TCP on 3478, TLS on 5349. |
| Relay forwarding | The last fallback, and the only path without WebRTC. |

**Ordering across paths.** A sender moves a link from the relay to its data channel only after putting a "path" marker on the relay; the receiver holds channel messages until that marker arrives. Waffle drops older sequence numbers, so this keeps every message. A channel that fails or stalls falls back to the relay and asks the session to resync (the CRDT's version vectors fill any gap).

**Identity.** Each editor makes an ECDSA P-256 key per session; its peer id is a hash of the public key. It signs (room, its relay connection id) and receivers bind the connection to the id only with a valid signature. The host's peer id is in the invitation, so guests can verify the host. This is what lets the CRDT insist that each live edit is its sender's own, and lets only the host send others' edits, merges and restore boundaries.

**Bad networks.** The relay answers the keepalive, so an editor finds a stalled relay connection within two beats (about 8 s) and replaces it; it retries about once a second, and at once when the network comes back (`online`) or the window does (AtriumPower: page visible, or the macOS window no longer occluded, as after a wake). Messages for everyone wait in the relay queue while disconnected (8 MB). Working data channels outlive a relay drop at both ends: an editor that comes back on a new relay connection proves who it is again, and its channel moves to the new connection id without a new negotiation. Edits that were lost in flight anyway reach the others through the session's catch-up on reconnect, because a guest keeps its own edits until the host confirms them ([collaboration.md](../collaboration.md#in-the-session)).

**Energy.** No polling: one timer, the relay keepalive's 4 s beat, which also runs the 20 s presence heartbeat (over the data channels when open); a 4 s lock heartbeat only while dragging. Idle, an editor wakes about 0.27 times a second, the same as before (measured by `scripts/perf-collab.sh`). With an older relay that does not answer the keepalive, the beat falls back to the heartbeat's 20 s. WebRTC's own consent checks run inside the browser.

## Platforms

| Host | WebRTC data channels | Notes |
|---|---|---|
| macOS app (WKWebView) | Yes | Checked on this Mac with a file:// page like the app's: `RTCPeerConnection`, a negotiated channel, `maxMessageSize` 256 KiB. WebKit hides host candidates without camera permission, so on one LAN the pair may meet through STUN (server reflexive) or TURN rather than host addresses. |
| Windows app (WebView2) | Yes | Chromium; nothing to enable. |
| Linux app (WebKitGTK) | Where built with WebRTC (2.38+ with the GStreamer backend) | `native/linux/waffle.py` turns on `enable-webrtc` when the setting exists. Without it the status reads "relay server only" and the relay carries everything. Not yet checked on the Ubuntu runner. |
| Browsers | Yes (Chrome, Edge, Firefox, Safari) | `http://127.0.0.1` is a secure context for local testing (`waffle_relay.py --dev`). |

## Same-network listeners

A host that shares a session as Visible on this network runs the relay's protocol itself (lan mode: one room, an `info` message with the salt, name and host id before the join). There are three implementations, one per desktop host, and one conformance suite, `native/tests/lan_relay.py`, that runs the same checks against each through a small driver (argv `ROOM SALT`, `WAFFLE_LAN_LIMITS` for scaled limits, `PORT`/`REPLY` lines, `host ID` and stop on stdin):

| Host | Listener | Discovery | Where it listens |
|---|---|---|---|
| Linux | `native/linux/lan_relay.py`: `collab/relay/waffle_relay.py` in lan mode | avahi (`avahi-publish-service`, `avahi-browse`) | loopback and the private addresses of interfaces with a device under `/sys/class/net`; default route's first |
| macOS | `native/macos/LanRelay.swift`: `NWListener` with the WebSocket protocol | Bonjour (`NWListener.Service`, `NetServiceBrowser`) | every interface but cellular and "other" (VPN); addresses listed from `en*` only |
| Windows | `native/windows/src/Core/LanRelay.cs`: `TcpListener` with RFC 6455 framing written out, as the relay does (`HttpListener` needs a URL ACL beyond loopback) | dnsapi `DnsServiceRegister`/`Browse`/`Resolve` (Windows 10 1903+), behind `ILanDiscovery` | loopback and the private addresses of adapters Windows marks as hardware (`MIB_IF_ROW2`), Ethernet or Wi-Fi, not named as virtual |

The standalone relay and the [threat model](../collaboration.md#threat-model) are the reference; where they differed, the stricter documented behaviour won (November 2026): macOS gained the relay's idle, per-address and join limits, slows a fast sender instead of cutting it off, answers `info` once, and returns `primary`; the relay's lan mode stopped serving `/healthz` and `/join`, admits four connections per place in the room, and keeps the first owner for the whole session (so a guest who arrives first after everyone left cannot take the host's role); `lanHost` answers `{ok: listening}` everywhere; every listener sends a message to each named recipient once. The relay's two-hour close of quiet rooms protects a public server from abandoned rooms; a LAN listener lives and ends with the host's session, so lan mode turns it off (`Limits.lan_room_idle`, 0) on all three, keeping the 10-minute idle timeout per connection, and an all-direct session is never forced to reconnect.

**Windows and `ws://`: the host opens the sockets.** WebView2 serves the editor from `https://app.waffle.example`. The host's own window joins its listener at `ws://127.0.0.1:<port>`, and a guest joins a host at `ws://address:48765`. Measured on 27 November 2026 with Playwright and headless Chrome 158.0.8127.37 on macOS, on a page served at `https://app.waffle.example/index.html` by request interception and a plain WebSocket server on the same Mac:

- `ws://192.168.50.8:<port>` failed. The console said "Mixed Content … This endpoint should be available via WSS." and `net::ERR_BLOCKED_BY_LOCAL_NETWORK_ACCESS_CHECKS`.
- `ws://127.0.0.1:<port>` failed with the same `ERR_BLOCKED_BY_LOCAL_NETWORK_ACCESS_CHECKS`.
- The server saw no upgrade request.

That was headless Chrome with an intercepted page, not WebView2 with a virtual-host mapping, so the address space and the permission handling may differ there; the [Windows checklist](../windows.md#same-network-sessions) confirms it on the shipped runtime. Waffle does not depend on the answer: on Windows every same-network WebSocket goes through the host.

- **Host** (`native/windows/src/Core/LanSockets.cs`): `lanConnect {url}` → `{socket}` connects with `System.Net.WebSockets.ClientWebSocket` (part of .NET Framework 4.8, no new dependency), only to `ws://` on loopback or a private address with a port and no path (a `.local` name must resolve to one), within 6 s; `lanSend {socket, data}` and `lanClose {socket}` need no reply; the host posts `{type: "lanSocket", socket, event: "message" | "drain" | "close", data | bytes}`. Text messages only, at most 8 sockets and 32 MB waiting per socket; every socket closes when the page reloads, fails or closes.
- **Page** (`native/bridge.js`, Windows only): `lanOpen(url)` gives the socket shape of the pairing code's sockets, and `AtriumHost.lanSocket()` returns `AtriumCollabPair.socketClass(lanOpen)`, the same WebSocket look-alike, which now accepts a URL and an opener that answers later. `bufferedAmount` counts what the host has not sent yet.
- **Editor** (`app/project/collab-presence.js`, two places): `begin()` uses `AtriumHost.lanSocket()` as the transport's `WebSocket` for a `ws://` address, and `lanInfo()` opens its socket with it; a host that refuses or finds nothing reads as "No Waffle session answered at …".
- **Checks:** `tests/project/collab-pair-browser.cjs` runs the same-network round a second time with the bridge's own socket code and a stand-in host of real WebSockets: host start, find, join by address, a wrong code and nothing answering all go through it, and the page opens no `ws://` itself. The Windows test program's `lan sockets` group connects `LanSockets` to the C# listener on loopback, through the bridge actions too, and checks the address rules.

**Keepalive answer.** Every listener answers `{"t": "p"}` with exactly `{"t": "p"}`, to the sender only, as the relay does since the resilience change: a client that hears nothing finds a dead link in about 8 s; a listener that never answered left LAN guests on the old 45 s keepalive. A ping counts toward its sender's rate limit and keeps its own connection from the 10-minute idle timeout (it is that connection's traffic, as on the relay); it is not room activity, which matters only where `lan_room_idle` is set. The conformance check `ping` covers all of this.

**Open items (not built).**

- **Rebinding when the host's address changes** (`native/linux/lan_relay.py`). Linux binds each private address it found at start, so a new DHCP lease, a move between Wi-Fi networks or a cable plugged in leaves the listener on a dead address while loopback keeps working. The fix is to watch `ip -j monitor address` (iproute2, no polling) while sharing, recompute `lan_networks()`, open listeners on added addresses on the same port and close the removed ones, and tell the page so the invitation and `address:port` update; that last part needs a host-to-page event the bridge does not have yet. Estimate: about half a day for Linux with a test that feeds monitor lines, plus a small page change for the new address. macOS needs nothing (its listener takes any interface). Windows would do the same as Linux with `NetworkChange.NetworkAddressChanged` (another half day).
- **Guests re-resolving the host by name before redialling.** A guest holds the address it found or typed; when the host's address changes, the transport redials the old one forever. The listeners would return the computer's local name in `lanStart` and the announcement already carries it: Bonjour and avahi publish under `<host>.local`, and on Windows `DnsServiceConstructInstance` is given `Dns.GetHostName() + ".local"`. Find Sessions would then keep the name next to the address, and the transport would try the name when a redial of the address fails. Browsers resolve `.local` through the system resolver on macOS and Windows; on Linux only with nss-mdns. On Windows the host socket already resolves `.local` names to a private address. Estimate: about a day, mostly in the transport's redial (`app/project/collab-transport.js`, owned elsewhere), plus half a day across the three hosts to return the name and test it.

## Checks

- `tests/project/collab-transport.cjs`: real Web Crypto, an in-process relay and WebRTC stand-in: verified identity, forged and replayed proofs, ordered relay-to-channel switch, fallback, a stalled peer, forced relay, TURN-only, no WebRTC, invitations.
- `tests/project/collab-relay.py`: the relay's protocol, limits, per-peer queues, TURN credentials, `/healthz`, `/join`, `--dev`.
- `native/tests/lan_relay.py`: the same-network listeners of Linux, macOS and Windows against one conformance suite.
- `tests/project/collab-session.cjs`: the session's trust rules (authors, host-only catch-up, merges and restore boundaries).
- `tests/project/collab-resilience.cjs`: two and three real session modules over a scripted network: offline and in-flight edits past the bounded log reach the host, the cap notice, a host-relayed session ending, hostile confirmations.
- `tests/project/collab-convergence.cjs --mode session`: randomised convergence under the session's catch-up rules, failing if a guest ever lacks an edit the host needs.
- `scripts/perf-collab.sh`: relay drop, stall and bounded-log scenarios in headless Chrome (detection, reconnect, lost edits, idle wake-ups).
- `scripts/collab-smoke.py RELAY`: two headless Chromium editors through a real relay: path and round trip for direct, TURN-only and relay-only.
- `scripts/collab-demo.py --only live`: two editors in Chrome through the whole session UI.

## Open questions

1. Measure direct-connection rates and TURN throughput across home, corporate and mobile networks with the Lightsail server.
2. Check WebKitGTK on the Ubuntu 24.04 runner (`enable-webrtc`, GStreamer WebRTC plugins) and on Fedora.
3. A guest that fell behind the bounded history while the host was away waits for the host; consider letting the host delegate.
4. Same-network sessions: rebinding when the host's address changes and re-resolving the host by name before redialling (the open items under [Same-network listeners](#same-network-listeners)).
5. A host whose window is the relay ends the session when it leaves. Handing the relay role to a guest would need the listener and its announcement on the guest, a new room for the same key and salt, and the guests redialling there; it is not built.
