"""Same-network live sessions for the Linux app (docs/collaboration.md, Other ways to connect).

While a host shares a session as "Visible on this network", this runs the Waffle relay
(collab/relay/waffle_relay.py, lan mode: one room, an info message with the session's public facts)
on the private addresses of the computer's physical Ethernet and Wi-Fi interfaces and on loopback,
never on containers, VMs, VPNs or other virtual interfaces (lan_networks), and
advertises it with mDNS (avahi-publish-service) as _waffle._tcp under the session's display name
only. Nothing listens before start() or after stop(). Joining still needs the session's key (the
short code the host reads out, or the link): the relay sees only ciphertext.

Browsing uses avahi-browse. Without avahi-utils, advertising and browsing say so; joining by
address still works.
"""
import asyncio
import ipaddress
import json
import os
import shutil
import socket
import subprocess
import sys
import threading
from pathlib import Path

HERE = Path(__file__).resolve().parent
for candidate in (HERE.parent.parent / "collab" / "relay", HERE.parent / "collab" / "relay"):
    if (candidate / "waffle_relay.py").is_file():
        sys.path.insert(0, str(candidate))
        break
import waffle_relay as R  # noqa: E402

SERVICE = "_waffle._tcp"
PORT = 48765          # the address people type: host:48765 (another free port if it is taken)


# Interfaces that are never "this computer's local network", whatever their address: containers and
# their bridges, VMs, VPNs and overlay networks. Loopback is always bound on its own (127.0.0.1).
VIRTUAL = ("lo", "docker", "br-", "veth", "virbr", "vnet", "tun", "tap", "wg", "tailscale", "zt", "vmnet", "vboxnet",
           "lxc", "lxd", "podman", "cni", "flannel", "cali", "kube", "vxlan", "gre", "ip6", "sit", "ppp", "dummy", "nordlynx", "ipsec")
SYS_NET = "/sys/class/net"


def physical(link, sys_net=SYS_NET):
    """A physical Ethernet or Wi-Fi interface: an "ether" link whose name is not a known virtual kind and
    that has a device under /sys/class/net/<if>/device (virtual interfaces have none). Where there is no
    /sys/class/net at all (not Linux), the name and link type decide."""
    name = str(link.get("ifname") or "")
    if not name or "/" in name or name.startswith(VIRTUAL):
        return False
    flags = link.get("flags", [])
    if "LOOPBACK" in flags or "POINTOPOINT" in flags:
        return False
    if link.get("link_type", "ether") != "ether":
        return False
    if os.path.isdir(sys_net):
        return os.path.exists(os.path.join(sys_net, name, "device"))
    return True


def default_route_interfaces(route_json=None):
    """Interface names carrying a default route, best (lowest metric) first. route_json: `ip -j route
    show default` output, for tests."""
    if route_json is None:
        try:
            route_json = subprocess.run(["ip", "-j", "route", "show", "default"], capture_output=True, text=True, timeout=3).stdout
        except (OSError, subprocess.SubprocessError):
            route_json = ""
    try:
        routes = [r for r in json.loads(route_json or "[]") if isinstance(r, dict) and r.get("dev")]
    except ValueError:
        return []
    routes.sort(key=lambda r: r.get("metric", 0) if isinstance(r.get("metric", 0), int) else 0)
    return list(dict.fromkeys(r["dev"] for r in routes))


def lan_addresses(ip_json=None, route_json=None, sys_net=SYS_NET):
    """Private IPv4 and unique-local IPv6 addresses of this computer's physical Ethernet and Wi-Fi
    interfaces (never loopback, containers, VMs or VPNs; no link-local, public or CGNAT addresses):
    the interface carrying the default route first, IPv4 before IPv6. ip_json: `ip -j addr` output,
    route_json: `ip -j route show default` output, sys_net: the sysfs network directory, for tests."""
    return lan_networks(ip_json, route_json, sys_net)["addresses"]


def lan_networks(ip_json=None, route_json=None, sys_net=SYS_NET):
    """{"addresses": as lan_addresses, "primary": the first address of the default-route interface
    (the one an invitation names), or None when no listed interface carries the default route}."""
    if ip_json is None:
        try:
            ip_json = subprocess.run(["ip", "-j", "addr", "show", "up"], capture_output=True, text=True, timeout=3).stdout
        except (OSError, subprocess.SubprocessError):
            ip_json = ""
    found = {}
    try:
        for link in json.loads(ip_json or "[]"):
            if not physical(link, sys_net):
                continue
            for a in link.get("addr_info", []):
                try:
                    ip = ipaddress.ip_address(a.get("local", ""))
                except ValueError:
                    continue
                if lan_address(ip):
                    found.setdefault(str(ip), link["ifname"])
    except (ValueError, AttributeError, TypeError):
        found = {}
    if not found and not ip_json:   # no iproute2: the address the default route uses
        try:
            with socket.socket(socket.AF_INET, socket.SOCK_DGRAM) as s:
                s.connect(("192.0.2.1", 9))
                ip = ipaddress.ip_address(s.getsockname()[0])
                if lan_address(ip):
                    found[str(ip)] = ""
        except OSError:
            pass
    routed = default_route_interfaces(route_json) if found and ip_json else []
    rank = {name: i for i, name in enumerate(routed)}
    ordered = sorted(found, key=lambda ip: (rank.get(found[ip], len(rank)), ":" in ip))
    primary = ordered[0] if ordered and (found[ordered[0]] in rank or not ip_json) else None
    return {"addresses": ordered, "primary": primary}


def lan_address(ip):
    if ip.is_loopback or ip.is_link_local or ip.is_multicast or ip.is_unspecified:
        return False
    if ip.version == 4:
        return any(ip in ipaddress.ip_network(n) for n in ("10.0.0.0/8", "172.16.0.0/12", "192.168.0.0/16"))
    return ip in ipaddress.ip_network("fc00::/7")


def parse_browse(text):
    """avahi-browse -rpt lines ("=;iface;IPv4;name;type;domain;host;address;port;txt") -> sessions."""
    sessions, seen = [], set()
    for line in text.splitlines():
        f = line.split(";")
        if len(f) < 9 or f[0] != "=" or f[4] != SERVICE:
            continue
        try:
            ip = ipaddress.ip_address(f[7])
            port = int(f[8])
        except ValueError:
            continue
        if ip.version == 6 and ip.is_link_local:
            continue
        name = f[3].replace("\\032", " ").replace("\\.", ".")[:64]
        key = (name, str(ip), port)
        if key in seen:
            continue
        seen.add(key)
        sessions.append({"name": name, "address": str(ip), "port": port})
    sessions.sort(key=lambda s: (s["name"].lower(), ":" in s["address"]))
    return sessions


def browse(timeout=4):
    tool = shutil.which("avahi-browse")
    if not tool:
        raise ValueError("Finding sessions on this network needs avahi (sudo apt install avahi-utils). You can still type the host's address.")
    try:
        out = subprocess.run([tool, "-rpt", SERVICE], capture_output=True, text=True, timeout=timeout).stdout
    except subprocess.TimeoutExpired as e:
        out = e.stdout.decode() if isinstance(e.stdout, bytes) else (e.stdout or "")
    return {"sessions": parse_browse(out)}


class LanRelay:
    """One shared session at a time. start() -> {"port", "addresses", "advertised"}."""

    def __init__(self, addresses=None, advertise=True):
        self.addresses, self.advertise = addresses, advertise
        self.loop = self.thread = self.server = self.relay = self.avahi = None

    @property
    def running(self):
        return self.server is not None

    def start(self, room, salt, name, port=PORT):
        if not (isinstance(room, str) and R.HEX64.match(room)):
            raise ValueError("Not a session id.")
        if not (isinstance(salt, str) and 16 <= len(salt) <= 64):
            raise ValueError("Not a session salt.")
        name = " ".join(str(name or "").split())[:63] or "Waffle session"
        self.stop()
        networks = {"addresses": self.addresses, "primary": None} if self.addresses is not None else lan_networks()
        addresses = networks["addresses"]
        if self.addresses is None and not addresses:
            raise ValueError("This computer is not on a local network (no Wi-Fi or Ethernet address).")
        self.relay = R.Relay(quiet=True, lan={"room": room, "salt": salt, "name": name, "host": None})
        self.loop = asyncio.new_event_loop()
        ready, failure = threading.Event(), []

        async def serve():
            hosts = ["127.0.0.1", *addresses]
            for p in (port, 0):
                try:
                    if p == 0:   # one free port for every address
                        with socket.socket() as probe:
                            probe.bind(("127.0.0.1", 0))
                            p = probe.getsockname()[1]
                    self.server = await asyncio.start_server(self.relay.serve, hosts, p, limit=64 * 1024)
                    break
                except OSError as e:
                    failure[:] = [e]
            ready.set()
            if self.server:
                sweeper = asyncio.ensure_future(self.relay.sweep())
                try:
                    async with self.server:
                        await self.server.serve_forever()
                except asyncio.CancelledError:
                    pass
                finally:
                    sweeper.cancel()

        def run():
            asyncio.set_event_loop(self.loop)
            self.task = self.loop.create_task(serve())
            try:
                self.loop.run_until_complete(self.task)
            except asyncio.CancelledError:
                pass
            finally:
                # Connections still open end with the listener.
                rest = asyncio.all_tasks(self.loop)
                for t in rest:
                    t.cancel()
                self.loop.run_until_complete(asyncio.gather(*rest, return_exceptions=True))
                self.loop.close()

        self.thread = threading.Thread(target=run, name="atrium-lan-relay", daemon=True)
        self.thread.start()
        ready.wait(5)
        if not self.server:
            self.stop()
            raise ValueError("Could not listen on the local network: %s" % (failure[0] if failure else "timed out"))
        bound = self.server.sockets[0].getsockname()[1]
        advertised = False
        if self.advertise:
            tool = shutil.which("avahi-publish-service")
            if tool:
                # The session's display name and port only (avahi publishes it under this computer's
                # existing local host name, as for any service on the network).
                self.avahi = subprocess.Popen([tool, "-s", name, SERVICE, str(bound), "v=2"], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
                advertised = True
        return {"port": bound, "addresses": addresses, "primary": networks["primary"], "advertised": advertised, "name": name}

    def set_host(self, host):
        if self.relay and isinstance(host, str) and len(host) <= 80:
            self.relay.lan["host"] = host
        return {"ok": self.running}

    def stop(self):
        if self.avahi:
            self.avahi.terminate()
            try:
                self.avahi.wait(2)
            except subprocess.TimeoutExpired:
                self.avahi.kill()
            self.avahi = None
        if self.loop and self.server:
            server, task = self.server, getattr(self, "task", None)

            def shut():
                server.close()
                for peer_room in list(self.relay.rooms.values()):
                    for peer in list(peer_room["peers"].values()):
                        peer.abort(1001)
                if task:
                    task.cancel()
            try:
                self.loop.call_soon_threadsafe(shut)
            except RuntimeError:
                pass
            if self.thread:
                self.thread.join(5)
        self.loop = self.thread = self.server = self.relay = None
        return {"stopped": True}


def handle(lan, action, request):
    """The bridge actions (native/bridge.js): lanStart, lanHost, lanStop, lanBrowse."""
    if action == "lanStart":
        return lan.start(request.get("room"), request.get("salt"), request.get("name"))
    if action == "lanHost":
        return lan.set_host(request.get("host"))
    if action == "lanStop":
        return lan.stop()
    if action == "lanBrowse":
        return browse()
    raise ValueError("unknown action")
