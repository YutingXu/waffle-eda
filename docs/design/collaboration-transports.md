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

**Energy.** No polling: a 20 s presence heartbeat over the data channels, a 45 s relay keepalive only when the relay socket is otherwise idle, a 4 s lock heartbeat only while dragging. WebRTC's own consent checks run inside the browser.

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
- `scripts/collab-smoke.py RELAY`: two headless Chromium editors through a real relay: path and round trip for direct, TURN-only and relay-only.
- `scripts/collab-demo.py --only live`: two editors in Chrome through the whole session UI.

## Open questions

1. Measure direct-connection rates and TURN throughput across home, corporate and mobile networks with the Lightsail server.
2. Check WebKitGTK on the Ubuntu 24.04 runner (`enable-webrtc`, GStreamer WebRTC plugins) and on Fedora.
3. A guest that fell behind the bounded history while the host was away waits for the host; consider letting the host delegate.
