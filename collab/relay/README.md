# Waffle collaboration relay

`waffle_relay.py` is the server side of Waffle live sessions (docs/collaboration.md). Editors in a room meet through it: it forwards their sealed WebRTC offers and answers so they can open direct data channels, carries their end-to-end encrypted edits when no direct or TURN channel works, and hands each joining editor short-lived TURN credentials for a coturn server beside it. It never sees a room key, the design or anyone's cursor, and it stores nothing.

It needs Python 3.8 or later and the standard library only.

```sh
python3 collab/relay/waffle_relay.py --dev                 # try it on one computer (see below)
python3 collab/relay/waffle_relay.py                       # ws://127.0.0.1:8765, this computer only
python3 collab/relay/waffle_relay.py --host 0.0.0.0        # the local network: ws://<this computer>:8765
python3 collab/relay/waffle_relay.py --host 0.0.0.0 --cert cert.pem --key key.pem   # wss:// without a proxy
```

For a server on the internet use [deploy/collab-server](../../deploy/collab-server/README.md): Caddy for TLS, coturn for TURN and this relay as a sandboxed service, set up by one launch script.

**Try it on one computer.** `--dev` also serves the editor at `http://127.0.0.1:8765/app/index.html` and sends invitation links (`/join#…`) there. Open it in two browser windows, set **Preferences › Collaboration › Relay server** to `ws://127.0.0.1:8765` in the first, then **Share › Start Session › Copy Link**, and open the link in the second window.

## Options

| Option | Meaning |
|---|---|
| `--turn-host HOST` | Hand out `stun:` / `turn:` / `turns:` URIs for coturn on HOST (ports 3478 and 5349). |
| `--turn-secret-file FILE` | coturn's `static-auth-secret` (`use-auth-secret`). Each join gets a username `<expiry>:<random>` and password HMAC-SHA1(secret, username). Without it, editors get STUN only. |
| `--turn-uri URI` | TURN URIs to hand out instead of the `--turn-host` defaults (repeatable). |
| `--turn-ttl SECONDS` | Credential lifetime (default 1 hour). Credentials go only to members the session's host has vouched for, while two are present, within per-session and per-address hourly budgets. |
| `--hosts-file FILE` | Private mode: only hosts whose token's SHA-256 is listed (one `hash name` per line; `SIGHUP` reloads) may start sessions. Guests join with the session link alone. |
| `--turn-off-file FILE` | While this file exists no TURN credentials are issued (the server kit's monthly cap). |
| `--trust-proxy` | Behind a reverse proxy on this computer: limit by `X-Forwarded-For`. |
| `--dev` / `--app DIR` | Serve the editor for local testing. |
| `--quiet` | No join and leave lines. |

## Notes

- **Endpoints.** `GET /healthz` returns `{"ok": true, "version": 2, "turn": …, "mode": "open" | "private"}`. `GET /join` is the landing page for invitation links; the invitation stays in the link's fragment, which the browser never sends. Any WebSocket upgrade is the relay.
- **Limits** (class `Limits`): 16 people per room (the room's owner can still join a full room), 256 rooms, 512 connections, 32 per address (an IPv6 /64 is one address), 60 joins per address per minute, 20 joins into one session per address per 10 minutes (each join is a new identity to the session). Messages are up to 1 MB, signalling 64 KB. A connection sending more than 400 messages or 24 MB per 10 s is slowed down, not cut off, so a host sending its project to several guests keeps its room. Memory is bounded: every peer has its own outgoing queue (6 MB), a sender is not read while a recipient is 3 MB behind, a recipient that stays behind for 5 s is disconnected, all queues share a 128 MB budget (checked before queueing), and messages being read reserve memory as well (160 MB for all connections, counting the copies a message takes on its way through), so 256 connections sending 1 MB frames to 16 rooms peak near 280 MB. Idle connections close after 10 minutes (editors send a tiny keepalive every 45 s when nothing else goes through the relay).
- **Logs.** Join and leave lines with a shortened room id; `--quiet` turns them off. Never message content, which is ciphertext anyway.
- **macOS.** The desktop app may refuse plain `ws://` to other computers. Use `wss://`.
- **Tests.** `python3 tests/project/collab-relay.py`; end to end `python3 scripts/collab-smoke.py ws://127.0.0.1:8765`.
