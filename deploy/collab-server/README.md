# Waffle collaboration server

One small Linux server lets people invite each other to live sessions (docs/collaboration.md):

- **Caddy** gets a Let's Encrypt certificate for your domain and serves `wss://DOMAIN`.
- **The Waffle relay** (`collab/relay/waffle_relay.py`) introduces editors to each other, carries their end-to-end encrypted edits when no direct connection works, and hands vouched members of a room short-lived TURN credentials. It runs as an unprivileged, sandboxed systemd service.
- **coturn** is the TURN server that WebRTC uses when two editors cannot reach each other directly (UDP and TCP on 3478, TLS on 5349, relayed traffic on UDP 49152–49999).

The server sees room ids, connection addresses and ciphertext only. Room keys stay in invitation links after the `#`, which browsers never send.

**Open by default.** Anyone whose Waffle has the server's address can host, and guests only ever need the session link. Nobody shares a key. Abuse is limited by quotas instead: connections, sessions and joins per address (an IPv6 /64 counts as one), idle sessions closed after two hours, and TURN, the costly part, rationed. TURN credentials (1 hour) go only to members the host has vouched for after they proved they hold the session's key, only while two such members are present, a bounded number per session and per address each hour, and coturn caps each allocation at 4 Mbit/s and all of them at 50 Mbit/s. A monthly TURN cap (100 GB by default) switches TURN off until the next month; sessions then keep working directly or through the relay. `sudo waffle-collab status` shows the month's usage.

**Private, if you want it.** `sudo waffle-collab mode private` lets only invited hosts start sessions. Each host gets a personal, revocable invitation: `sudo waffle-collab add-host "Alice"` prints a link; opening it in Waffle (or pasting it into **Share**) sets up hosting on this server. `sudo waffle-collab remove-host "Alice"` revokes it; `list-hosts` lists them. Guests still need only the session link.

The smallest Lightsail plan is enough for a team.

From a source checkout, run `python3 scripts/gen-collab-launch.py` to prepare the two scripts below in `deploy/collab-server/`.

## 1. Create the instance (AWS Lightsail)

1. Lightsail console › **Create instance**: platform **Linux/Unix**, blueprint **OS Only › Ubuntu 24.04 LTS**, the smallest plan.
2. Optional: **Add launch script** with `launch-script.sh` (8 KB). Set `DOMAIN` (and, if you like, `ACME_EMAIL`) at its top first. It prepares Caddy, coturn, the firewall and automatic updates at first boot, so the certificate is ready sooner. It does not contain the relay; step 5 adds it either way.
3. Name the instance and **Create instance**.

## 2. Attach a static IP

Instance › **Networking** › **Attach static IP** (create one, attach it). Note the address, for example `203.0.113.10`. If you enable IPv6, note the instance's IPv6 address too. The server picks up a new address within 15 minutes; `sudo waffle-collab reconfigure DOMAIN` applies it at once.

## 3. Open the firewall (Lightsail networking)

Instance › **Networking** › **IPv4 Firewall** › **Add rule** for each row, then the same under **IPv6 Firewall** if IPv6 is on. They match the server's own `ufw` rules.

| Application | Protocol | Port or range | Purpose |
|---|---|---|---|
| SSH | TCP | 22 | administration (already there) |
| HTTP | TCP | 80 | Let's Encrypt challenge, redirect |
| HTTPS | TCP | 443 | `wss://` relay, `/healthz`, `/join` |
| Custom | UDP | 3478 | STUN/TURN |
| Custom | TCP | 3478 | TURN over TCP |
| Custom | TCP | 5349 | TURN over TLS |
| Custom | UDP | 49152 – 49999 | TURN relayed traffic |

## 4. DNS

At your DNS provider, for your domain:

- Type **A**, name `collab` (your subdomain), value: the static IP, TTL **600 seconds**.
- With IPv6: type **AAAA**, name `collab`, value: the instance's IPv6 address, TTL 600.

DNS takes a few minutes to an hour. The server does not need to wait: Caddy keeps retrying the certificate until the name points at it.

## Upgrade an existing server

Run the complete `waffle-setup.sh` installer on the existing server with no arguments.
It reuses the saved domain, ACME email, private host list, TURN secret, traffic cap and
usage history. It stops the old relay and certificate timer, moves the kit's configuration
and state, and starts `waffle-relay.service` and `waffle-collab-certs.timer`. Caddy
and coturn keep their certificates. A brief relay interruption is expected. If both
configuration directories already exist, setup stops before changing either one.

## 5. Install (browser SSH)

Lightsail › the instance › **Connect using SSH**. In that terminal:

```sh
sudo tee /root/waffle-setup.sh >/dev/null
```

Paste the whole of `waffle-setup.sh` (about 17 KB), press **Enter**, then **Ctrl+D**. Then:

```sh
sudo bash /root/waffle-setup.sh collab.example.org you@example.org
```

(After the launch script, `sudo bash /root/waffle-setup.sh` alone keeps its domain.) The e-mail is optional. Running the installer again updates the relay and keeps the server's secret and settings. If the paste was altered on the way, it says so and changes nothing: copy the file again as plain text.

## 6. Check it

From your computer:

```sh
curl https://collab.example.org/healthz
# {"ok": true, "version": 2, "turn": true, "mode": "open"}
```

On the server:

```sh
sudo waffle-collab status       # services, DNS, certificate, reachability, TURN usage, mode
sudo waffle-collab turn-test    # fresh TURN credentials and a UDP/TCP allocation test
sudo waffle-collab logs         # relay, coturn and Caddy logs
```

`turn-test` also prints credentials you can paste into the WebRTC [Trickle ICE](https://webrtc.github.io/samples/src/content/peerconnection/trickle-ice/) page from any computer: a `relay` candidate means TURN works through the Lightsail firewall.

`status` also connects to the server's own public address, which on Lightsail passes through the instance firewall: "port 443 looks closed in the Lightsail firewall" means the HTTPS rule from step 3 is missing (port 80 alone lets the certificate be issued, but nobody can connect).

If the domain was wrong, or DNS was not ready and you want to retry at once: `sudo waffle-collab reconfigure collab.example.org you@example.org`. The setup log is `/var/log/waffle-collab-setup.log` (root only, with no secrets in it).

## 7. Use it in Waffle

1. **Preferences › Collaboration**: **Relay server** = `wss://collab.example.org`, and turn on **Enable live sessions**. (On a private server, open your host invitation link instead: it does both.)
2. **Share › Start Session**. Choose **Copy Link** (or **Copy as Text**) and send it privately.
3. On the second computer, open the link (or paste it, or the text, into Waffle's **Share › Join**). The status shows whether the editors connected **directly**, **via TURN** or **via relay server**.

**Connection** on the same Preferences page can keep everything on TURN (editors do not learn each other's IP addresses) or on the relay server, for networks that block WebRTC.

## Try it before the server is up

On one computer, from the repository root:

```sh
python3 collab/relay/waffle_relay.py --dev
```

Open `http://127.0.0.1:8765/app/index.html` in two browser windows (or a normal and a private window). In the first, set **Preferences › Collaboration › Relay server** to `ws://127.0.0.1:8765`, then **Share › Start Session** and **Copy Link**. Paste the link into the second window's address bar: it opens Waffle with the invitation, and **Join Session** joins. On one computer the editors connect directly; there is no TURN in this mode.

`python3 scripts/collab-smoke.py ws://127.0.0.1:8765` (or `wss://collab.example.org` once the server is up; `--host-token` for a private server) runs two headless editors through the same flow and reports the path and round-trip time: direct (WebRTC), TURN-only and relay-only.

## Maintenance

- **Updates.** Ubuntu security updates and Caddy (from Caddy's own repository) install automatically (the repository key is checked against its pinned fingerprint, and only the `caddy` package may come from that repository). coturn comes from Ubuntu's *universe*; its security fixes arrive through Ubuntu Pro (ESM): `sudo pro attach TOKEN` (free for personal use on up to five machines) adds them to the automatic updates.
- **Certificate.** Caddy renews it; a timer hands it to coturn within 15 minutes.
- **New relay version.** Run the new `waffle-setup.sh` again (or copy `collab/relay/waffle_relay.py` to `/opt/waffle-collab/` and `sudo systemctl restart waffle-relay`).
- **Rotate the TURN secret:** `sudo waffle-collab rotate-secret`. **TURN cap:** `sudo waffle-collab turn-cap 200` (GB a month; 0 for none).

## Notes on trust

- Whoever controls this server could change the `/join` page so that it reads the invitation in the address bar. Keep the server patched and its SSH key private; Waffle itself never loads that page.
- A direct WebRTC connection shows each editor the other's IP address. Choose **Connection › Only through TURN** in Preferences to avoid that.

## Files

- `waffle-setup.sh` and `launch-script.sh`: generated by `python3 scripts/gen-collab-launch.py` from the two files below (`--check` in CI; `tests/project/collab-server-kit.py` runs the relay's tests against the packed copy). Edit those, then regenerate.
- `waffle-collab`: the setup and status helper (installed as `/usr/local/sbin/waffle-collab`). It writes `/etc/caddy/Caddyfile`, `/etc/turnserver.conf`, `/etc/systemd/system/waffle-relay.service`, a certificate timer, the `ufw` rules and the automatic-update settings, and keeps the TURN secret in `/etc/waffle-collab/` (root only; the relay gets it as a systemd credential), private mode's host list (hashes only) in `/etc/waffle-relay/hosts`, TURN usage in `/var/lib/waffle-collab/` and coturn's copy of the certificate in `/etc/coturn/tls/`.
- `../../collab/relay/waffle_relay.py`: the relay.
