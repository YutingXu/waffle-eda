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

## Checks

- `tests/collab-transport.cjs`: real Web Crypto, an in-process relay and WebRTC stand-in: verified identity, forged and replayed proofs, ordered relay-to-channel switch, fallback, a stalled peer, forced relay, TURN-only, no WebRTC, invitations.
- `tests/collab-relay.py`: the relay's protocol, limits, per-peer queues, TURN credentials, `/healthz`, `/join`, `--dev`.
- `tests/collab-session.cjs`: the session's trust rules (authors, host-only catch-up, merges and restore boundaries).
- `tests/project/collab-resilience.cjs`: two and three real session modules over a scripted network: offline and in-flight edits past the bounded log reach the host, the cap notice, a host-relayed session ending, hostile confirmations.
- `tests/project/collab-convergence.cjs --mode session`: randomised convergence under the session's catch-up rules, failing if a guest ever lacks an edit the host needs.
- `scripts/perf-collab.sh`: relay drop, stall and bounded-log scenarios in headless Chrome (detection, reconnect, lost edits, idle wake-ups).
- `scripts/collab-smoke.py RELAY`: two headless Chromium editors through a real relay: path and round trip for direct, TURN-only and relay-only.
- `scripts/collab-demo.py --only live`: two editors in Chrome through the whole session UI.

## Open questions

1. Measure direct-connection rates and TURN throughput across home, corporate and mobile networks with the Lightsail server.
2. Check WebKitGTK on the Ubuntu 24.04 runner (`enable-webrtc`, GStreamer WebRTC plugins) and on Fedora.
3. A guest that fell behind the bounded history while the host was away waits for the host; consider letting the host delegate.
4. The LAN listeners (`native/macos/LanRelay.swift`, `native/linux/lan_relay.py`) do not answer the keepalive yet, so a guest on a session shared on this network finds a dead Wi-Fi link only through TCP. Answering `{"t":"p"}` with `{"t":"p"}` to the sender is all they need. The Linux listener should also rebind when the host's address changes, and guests could re-resolve the host by its Bonjour or avahi name before redialling a stale address.
5. A host whose window is the relay ends the session when it leaves. Handing the relay role to a guest would need the listener and its announcement on the guest, a new room for the same key and salt, and the guests redialling there; it is not built.
