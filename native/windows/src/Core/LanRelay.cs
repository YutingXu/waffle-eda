// Same-network live sessions for the Windows app (docs/collaboration.md, Other ways to connect).
//
// While a host shares a session as "Visible on this network", LanRelay runs the Waffle relay protocol
// (version 2, lan mode, as collab/relay/waffle_relay.py with `lan` and native/macos/LanRelay.swift: one
// room, an info message with the session's public facts, the relay's limits) over WebSocket on loopback
// and on the private addresses of this computer's physical Ethernet and Wi-Fi adapters, never VPN,
// Hyper-V, WSL, container or other virtual adapters (LanNetworks), and announces it with DNS-SD as
// _waffle._tcp under the session's display name only (ILanDiscovery; DnsSdDiscovery in src/Win).
// Nothing listens before Start or after Stop. Joining still needs the session's key: the relay sees
// only ciphertext. The WebSocket framing is written here (RFC 6455, server side), as in
// waffle_relay.py: HttpListener would need a URL ACL for any address but loopback.
// native/tests/lan_relay.py runs one conformance suite against this listener (the test program's
// --lan-relay driver), the macOS one and the Linux one.
using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.IO;
using System.Linq;
using System.Net;
using System.Net.NetworkInformation;
using System.Net.Sockets;
using System.Security.Cryptography;
using System.Text;
using System.Text.RegularExpressions;
using System.Threading;
using System.Threading.Tasks;

namespace Waffle.Windows
{
    /// The relay's limits (waffle_relay.py, class Limits). Tests may change them before Start.
    public static class LanLimits
    {
        public static int Frame = 1 << 20, Signal = 64 * 1024, Peers = 16, PerAddress = 32, Joins = 60, RoomJoins = 20;
        public static int RateMessages = 400, RateBytes = 24 << 20, Queue = 6 << 20, QueueSoft = 3 << 20;
        public static double JoinTimeout = 10, Idle = 600, RateWindow = 10, Stall = 5, Sweep = 60;
        /// A quiet room is never closed: the listener ends with the host's session (waffle_relay.py lan_room_idle; 0: off).
        public static double LanRoomIdle = 0;

        /// One limit by its waffle_relay.py name (the conformance driver's WAFFLE_LAN_LIMITS); false if unknown.
        public static bool Set(string name, double value)
        {
            switch (name)
            {
                case "frame": Frame = (int)value; break;
                case "signal": Signal = (int)value; break;
                case "peers": Peers = (int)value; break;
                case "per_address": PerAddress = (int)value; break;
                case "joins": Joins = (int)value; break;
                case "room_joins": RoomJoins = (int)value; break;
                case "rate_messages": RateMessages = (int)value; break;
                case "rate_bytes": RateBytes = (int)Math.Min(value, int.MaxValue); break;
                case "queue": Queue = (int)value; break;
                case "queue_soft": QueueSoft = (int)value; break;
                case "join_timeout": JoinTimeout = value; break;
                case "idle": Idle = value; break;
                case "rate_window": RateWindow = value; break;
                case "stall": Stall = value; break;
                case "lan_room_idle": LanRoomIdle = value; break;
                case "room_idle": break;   // the public relay's rule for abandoned rooms; never on the local network
                case "sweep": Sweep = value; break;
                default: return false;
            }
            return true;
        }
    }

    /// A session announced on the network, as found (LanRelay.Sessions cleans and sorts them).
    public sealed class LanFound
    {
        public string Name, Address;
        public int Port;
    }

    /// Announcing and finding _waffle._tcp (DnsSdDiscovery on Windows). Failures degrade: no
    /// announcement, and Find Sessions asks for the host's address instead.
    public interface ILanDiscovery
    {
        /// Announces the session name and port only; false when it could not.
        bool Advertise(string name, int port);
        void Withdraw();
        /// Sessions answering within the timeout; throws when this computer cannot look.
        IList<LanFound> Browse(TimeSpan timeout);
    }

    /// One network adapter as LanNetworks sees it.
    public sealed class LanInterface
    {
        public string Name = "", Description = "";
        public NetworkInterfaceType Type;
        public bool Up, Hardware, Gateway;
        public IList<IPAddress> Addresses = new List<IPAddress>();
    }

    /// Which addresses are "this computer on this network": private addresses of physical, connected
    /// Ethernet and Wi-Fi adapters only, as on Linux (lan_relay.lan_networks) and macOS (en* only).
    public static class LanNetworks
    {
        // Virtual adapters that may still look like Ethernet: Hyper-V and WSL switches, VM host-only
        // networks, VPNs and tunnels, packet capture, Bluetooth and Wi-Fi Direct.
        static readonly string[] Virtual = { "virtual", "hyper-v", "vethernet", "wsl", "vmware", "virtualbox", "vbox", "parallels", "docker",
            "tap-", "tap ", "tun", "wintun", "wireguard", "tailscale", "zerotier", "openvpn", "vpn", "nordlynx", "npcap", "loopback",
            "bluetooth", "wi-fi direct", "teredo", "isatap", "6to4", "pseudo", "kernel debug" };

        public static bool Private(IPAddress ip)
        {
            if (ip == null || IPAddress.IsLoopback(ip) || ip.IsIPv6LinkLocal || ip.IsIPv6Multicast || ip.IsIPv6SiteLocal) return false;
            var b = ip.GetAddressBytes();
            if (ip.AddressFamily == AddressFamily.InterNetwork)
                return b[0] == 10 || (b[0] == 172 && b[1] >= 16 && b[1] <= 31) || (b[0] == 192 && b[1] == 168);
            return ip.AddressFamily == AddressFamily.InterNetworkV6 && !ip.IsIPv4MappedToIPv6 && (b[0] & 0xFE) == 0xFC;
        }

        public static bool Physical(LanInterface i)
        {
            if (i == null || !i.Up || !i.Hardware) return false;
            if (i.Type != NetworkInterfaceType.Ethernet && i.Type != NetworkInterfaceType.Wireless80211 && i.Type != NetworkInterfaceType.GigabitEthernet &&
                i.Type != NetworkInterfaceType.FastEthernetT && i.Type != NetworkInterfaceType.FastEthernetFx) return false;
            var text = ((i.Name ?? "") + " " + (i.Description ?? "")).ToLowerInvariant();
            return !Virtual.Any(v => text.IndexOf(v, StringComparison.Ordinal) >= 0);
        }

        /// Private IPv4 and unique-local IPv6 addresses of physical adapters: those with a default
        /// gateway first, IPv4 before IPv6.
        public static List<string> Addresses(IEnumerable<LanInterface> interfaces)
        {
            var found = new List<Tuple<string, bool, bool, int>>();
            foreach (var i in interfaces ?? Enumerable.Empty<LanInterface>())
            {
                if (!Physical(i)) continue;
                foreach (var ip in i.Addresses ?? new List<IPAddress>())
                {
                    if (!Private(ip)) continue;
                    var text = ip.ToString();
                    if (found.All(f => f.Item1 != text)) found.Add(Tuple.Create(text, i.Gateway, ip.AddressFamily == AddressFamily.InterNetworkV6, found.Count));
                }
            }
            return found.OrderBy(f => f.Item2 ? 0 : 1).ThenBy(f => f.Item3 ? 1 : 0).ThenBy(f => f.Item4).Select(f => f.Item1).ToList();
        }

        /// This computer's adapters. hardware(index): MIB_IF_ROW2's HardwareInterface flag (Native.HardwareInterface).
        public static List<LanInterface> Inventory(Func<int, bool?> hardware)
        {
            var list = new List<LanInterface>();
            NetworkInterface[] all;
            try { all = NetworkInterface.GetAllNetworkInterfaces(); }
            catch (NetworkInformationException) { return list; }
            foreach (var n in all)
            {
                try
                {
                    var props = n.GetIPProperties();
                    int index = -1;
                    try { var v4 = props.GetIPv4Properties(); if (v4 != null) index = v4.Index; } catch (Exception) { }
                    if (index < 0) try { var v6 = props.GetIPv6Properties(); if (v6 != null) index = v6.Index; } catch (Exception) { }
                    list.Add(new LanInterface
                    {
                        Name = n.Name ?? "", Description = n.Description ?? "", Type = n.NetworkInterfaceType,
                        Up = n.OperationalStatus == OperationalStatus.Up,
                        Hardware = index >= 0 && hardware != null && hardware(index) == true,
                        Gateway = props.GatewayAddresses.Any(g => g.Address != null && !g.Address.Equals(IPAddress.Any) && !g.Address.Equals(IPAddress.IPv6Any)),
                        Addresses = props.UnicastAddresses.Select(u => u.Address).ToList(),
                    });
                }
                catch (NetworkInformationException) { }
            }
            return list;
        }

        /// The address the default route leaves from, when it is one of these (the invitation names it);
        /// null behind a VPN or without a route. Connecting a UDP socket sends nothing.
        public static string Primary(IList<string> addresses)
        {
            if (addresses == null || addresses.Count == 0) return null;
            try
            {
                using (var s = new Socket(AddressFamily.InterNetwork, SocketType.Dgram, ProtocolType.Udp))
                {
                    s.Connect(new IPEndPoint(IPAddress.Parse("192.0.2.1"), 9));
                    var ip = ((IPEndPoint)s.LocalEndPoint).Address.ToString();
                    return addresses.Contains(ip) ? ip : null;
                }
            }
            catch (SocketException) { return null; }
        }
    }

    /// One session shared on the network at a time. The bridge actions (Host.cs): lanStart, lanHost,
    /// lanStop, lanBrowse, with the same replies as on macOS and Linux.
    public sealed class LanRelay
    {
        public const string Service = "_waffle._tcp";
        public const int DefaultPort = 48765;
        static readonly Regex Hex64 = new Regex(@"\A[0-9a-f]{64}\z");

        readonly ILanDiscovery discovery;
        readonly Func<IEnumerable<LanInterface>> interfaces;
        readonly bool loopbackOnly;
        readonly object gate = new object();
        Session current;
        bool advertised;

        /// interfaces: this computer's adapters (LanNetworks.Inventory); none means no local network.
        /// loopbackOnly: listen on 127.0.0.1 alone (the tests).
        public LanRelay(ILanDiscovery discovery = null, Func<IEnumerable<LanInterface>> interfaces = null, bool loopbackOnly = false)
        {
            this.discovery = discovery;
            this.interfaces = interfaces;
            this.loopbackOnly = loopbackOnly;
        }

        public bool Running { get { lock (gate) return current != null; } }

        /// lanStart: {port, addresses, primary, advertised, name}.
        public Dictionary<string, object> Start(string room, string salt, string name, int port = DefaultPort)
        {
            if (room == null || !Hex64.IsMatch(room)) throw new HostError("Not a session id.");
            if (salt == null || salt.Length < 16 || salt.Length > 64) throw new HostError("Not a session salt.");
            var display = string.Join(" ", (name ?? "").Split((char[])null, StringSplitOptions.RemoveEmptyEntries));
            if (display.Length > 63) display = display.Substring(0, char.IsHighSurrogate(display[62]) ? 62 : 63);
            if (display.Length == 0) display = "Waffle session";
            Stop();
            var addresses = loopbackOnly ? new List<string>() : LanNetworks.Addresses(interfaces?.Invoke());
            if (!loopbackOnly && addresses.Count == 0) throw new HostError("This computer is not on a local network (no Wi-Fi or Ethernet address).");
            var primary = LanNetworks.Primary(addresses);
            if (primary != null) { addresses.Remove(primary); addresses.Insert(0, primary); }
            var session = new Session(room, salt, display);
            var bound = session.Listen(addresses, port);
            bool announced = false;
            if (discovery != null) { try { announced = discovery.Advertise(display, bound); } catch (Exception) { announced = false; } }
            lock (gate) { current = session; advertised = announced; }
            return new Dictionary<string, object> {
                { "port", bound }, { "addresses", addresses.Cast<object>().ToList() }, { "primary", primary }, { "advertised", announced }, { "name", display },
            };
        }

        /// lanHost: the host's peer id, given to guests in info. {ok: listening}.
        public Dictionary<string, object> SetHost(string host)
        {
            lock (gate)
            {
                if (current != null && host != null && host.Length <= 80) current.Host = host;
                return new Dictionary<string, object> { { "ok", current != null } };
            }
        }

        /// lanStop: the listener, its announcement and every connection end. {stopped: true}.
        public Dictionary<string, object> Stop()
        {
            Session session;
            bool announced;
            lock (gate) { session = current; announced = advertised; current = null; advertised = false; }
            if (session != null)
            {
                session.Shutdown();
                if (announced) { try { discovery?.Withdraw(); } catch (Exception) { } }
            }
            return new Dictionary<string, object> { { "stopped", true } };
        }

        /// lanBrowse: {sessions: [{name, address, port}]}.
        public Dictionary<string, object> Browse()
        {
            const string type = " You can still type the host's address.";
            if (discovery == null) throw new HostError("Finding sessions on this network isn't available here." + type);
            IList<LanFound> found;
            try { found = discovery.Browse(TimeSpan.FromSeconds(2.5)); }
            catch (Exception) { throw new HostError("Waffle couldn't look for sessions on this network." + type); }
            return new Dictionary<string, object> { { "sessions", Sessions(found) } };
        }

        /// Sessions as every host lists them: by name, IPv4 before IPv6, no link-local addresses, no repeats.
        public static List<object> Sessions(IEnumerable<LanFound> found)
        {
            var seen = new HashSet<string>();
            var list = new List<Dictionary<string, object>>();
            foreach (var f in found ?? Enumerable.Empty<LanFound>())
            {
                if (f == null || f.Name == null || f.Port <= 0 || f.Port > 65535 || !IPAddress.TryParse(f.Address ?? "", out var ip)) continue;
                if (ip.IsIPv6LinkLocal || ip.AddressFamily == AddressFamily.InterNetworkV6 && ip.ScopeId != 0) continue;
                var name = f.Name.Length > 64 ? f.Name.Substring(0, 64) : f.Name;
                var address = ip.ToString();
                if (!seen.Add(name + "\n" + address + "\n" + f.Port)) continue;
                list.Add(new Dictionary<string, object> { { "name", name }, { "address", address }, { "port", f.Port } });
            }
            return list.OrderBy(s => ((string)s["name"]).ToLowerInvariant(), StringComparer.Ordinal)
                       .ThenBy(s => ((string)s["address"]).Contains(":") ? 1 : 0).Cast<object>().ToList();
        }

        // ------------------------------------------------------------------ the relay

        static double Now => Stopwatch.GetTimestamp() / (double)Stopwatch.Frequency;

        static string Hex(byte[] bytes)
        {
            var b = new StringBuilder(bytes.Length * 2);
            foreach (var x in bytes) b.Append(x.ToString("x2"));
            return b.ToString();
        }

        static string Sha256(byte[] data) { using (var h = SHA256.Create()) return Hex(h.ComputeHash(data)); }

        static byte[] FromHex(string hex)
        {
            var bytes = new byte[hex.Length / 2];
            for (int i = 0; i < bytes.Length; i++) bytes[i] = Convert.ToByte(hex.Substring(2 * i, 2), 16);
            return bytes;
        }

        static string Str(Dictionary<string, object> d, string key) => d.TryGetValue(key, out var v) ? v as string : null;

        static byte[] Frame(int op, byte[] payload)
        {
            int n = payload.Length, at;
            byte[] frame;
            if (n < 126) { frame = new byte[2 + n]; frame[1] = (byte)n; at = 2; }
            else if (n < 65536) { frame = new byte[4 + n]; frame[1] = 126; frame[2] = (byte)(n >> 8); frame[3] = (byte)n; at = 4; }
            else { frame = new byte[10 + n]; frame[1] = 127; for (int i = 0; i < 8; i++) frame[9 - i] = (byte)((long)n >> (8 * i)); at = 10; }
            frame[0] = (byte)(0x80 | op);
            Buffer.BlockCopy(payload, 0, frame, at, n);
            return frame;
        }

        static byte[] Text(object message) => Frame(0x1, Encoding.UTF8.GetBytes(Json.Write(message)));

        static readonly UTF8Encoding StrictUtf8 = new UTF8Encoding(false, true);

        sealed class Closed : Exception { }

        /// Buffered reads from a connection: the request head, then frames.
        sealed class Reader
        {
            readonly Stream stream;
            readonly byte[] buffer = new byte[16 * 1024];
            int at, end;
            public Reader(Stream stream) { this.stream = stream; }

            async Task Fill()
            {
                at = 0;
                end = await stream.ReadAsync(buffer, 0, buffer.Length).ConfigureAwait(false);
                if (end <= 0) { end = 0; throw new Closed(); }
            }

            public async Task<byte[]> Exact(int n)
            {
                var data = new byte[n];
                for (int got = 0; got < n;)
                {
                    if (at == end) await Fill().ConfigureAwait(false);
                    int take = Math.Min(n - got, end - at);
                    Buffer.BlockCopy(buffer, at, data, got, take);
                    at += take;
                    got += take;
                }
                return data;
            }

            /// The HTTP request head up to the blank line; null past `limit` bytes.
            public async Task<string> Head(int limit)
            {
                var head = new List<byte>();
                while (head.Count < limit)
                {
                    if (at == end) await Fill().ConfigureAwait(false);
                    head.Add(buffer[at++]);
                    int n = head.Count;
                    if (n >= 4 && head[n - 4] == '\r' && head[n - 3] == '\n' && head[n - 2] == '\r' && head[n - 1] == '\n')
                        return Encoding.GetEncoding("ISO-8859-1").GetString(head.ToArray());
                }
                return null;
            }
        }

        /// One connection. Outgoing frames go through its own queue and writer.
        sealed class Peer
        {
            public readonly TcpClient Client;
            public readonly Stream Stream;
            public readonly Reader Reader;
            public readonly string Address;
            public string Id;
            public bool Owner, Upgraded, Counted, Closing, Ended;
            public double Heard, WindowStart;
            public int WindowCount;
            public long WindowBytes;
            public readonly Queue<byte[]> Out = new Queue<byte[]>();
            public int Queued;
            public readonly SemaphoreSlim Wake = new SemaphoreSlim(0);
            public Timer Watch;

            public Peer(TcpClient client, string address)
            {
                Client = client;
                Stream = client.GetStream();
                Reader = new Reader(Stream);
                Address = address;
                Heard = WindowStart = Now;
            }
        }

        /// The shared session: its listeners, its one room and its limits.
        sealed class Session
        {
            static readonly byte[] WebSocketGuid = Encoding.ASCII.GetBytes("258EAFA5-E914-47DA-95CA-C5AB0DC85B11");
            readonly string room, salt, name;
            public volatile string Host;
            readonly object gate = new object();
            readonly List<TcpListener> listeners = new List<TcpListener>();
            readonly List<Peer> all = new List<Peer>();
            readonly Dictionary<string, Peer> members = new Dictionary<string, Peer>();
            readonly Dictionary<string, int> byAddress = new Dictionary<string, int>();
            readonly Dictionary<string, Queue<double>> joins = new Dictionary<string, Queue<double>>(), roomJoins = new Dictionary<string, Queue<double>>();
            string owner;
            double active = Now;
            Timer sweeper;
            bool closed;

            public Session(string room, string salt, string name) { this.room = room; this.salt = salt; this.name = name; }

            /// Binds loopback and each address on one port (the default, else a free one); the bound port.
            public int Listen(IList<string> addresses, int port)
            {
                var hosts = new List<IPAddress> { IPAddress.Loopback };
                hosts.AddRange(addresses.Select(a => IPAddress.Parse(a)));
                Exception failure = null;
                foreach (var p in new[] { port, 0 })
                {
                    try { Bind(hosts, p); failure = null; break; }
                    catch (SocketException e) { failure = e; Unbind(); }
                }
                if (failure != null) throw new HostError("Could not listen on the local network: " + failure.Message);
                foreach (var l in listeners) _ = AcceptLoop(l);
                var every = TimeSpan.FromSeconds(LanLimits.Sweep);
                if (LanLimits.LanRoomIdle > 0) sweeper = new Timer(_ => Sweep(), null, every, every);
                return ((IPEndPoint)listeners[0].LocalEndpoint).Port;
            }

            void Bind(List<IPAddress> hosts, int port)
            {
                foreach (var host in hosts)
                {
                    var l = new TcpListener(host, port);
                    try { l.ExclusiveAddressUse = true; } catch (Exception) { }   // Windows: no other program can take the port over
                    l.Start();
                    listeners.Add(l);
                    if (port == 0) port = ((IPEndPoint)l.LocalEndpoint).Port;   // one free port for every address
                }
            }

            void Unbind()
            {
                foreach (var l in listeners) { try { l.Stop(); } catch (Exception) { } }
                listeners.Clear();
            }

            public void Shutdown()
            {
                List<Peer> peers;
                lock (gate) { closed = true; peers = all.ToList(); }
                sweeper?.Dispose();
                Unbind();
                foreach (var p in peers) { if (p.Upgraded) Close(p, 1001, true); else End(p); }
            }

            async Task AcceptLoop(TcpListener listener)
            {
                while (true)
                {
                    TcpClient client;
                    try { client = await listener.AcceptTcpClientAsync().ConfigureAwait(false); }
                    catch (SocketException e) when (e.SocketErrorCode == SocketError.ConnectionReset || e.SocketErrorCode == SocketError.ConnectionAborted) { continue; }
                    catch (Exception) { return; }   // stopped
                    _ = Serve(client);
                }
            }

            static string AddressOf(TcpClient client)
            {
                if (!(client.Client.RemoteEndPoint is IPEndPoint ep)) return "local";
                var ip = ep.Address;
                if (ip.IsIPv4MappedToIPv6) ip = ip.MapToIPv4();
                if (ip.AddressFamily != AddressFamily.InterNetworkV6) return ip.ToString();
                var prefix = new byte[16];
                Array.Copy(ip.GetAddressBytes(), prefix, 8);
                return new IPAddress(prefix) + "/64";   // an IPv6 /64 is one address, as on the relay
            }

            async Task Serve(TcpClient client)
            {
                Peer p;
                lock (gate)
                {
                    // At most four connections per place in the room (waffle_relay.py, lan mode).
                    if (closed || all.Count >= 4 * LanLimits.Peers) { try { client.Close(); } catch (Exception) { } return; }
                    try { p = new Peer(client, AddressOf(client)); }
                    catch (Exception) { try { client.Close(); } catch (Exception) { } return; }
                    all.Add(p);
                }
                try
                {
                    client.NoDelay = true;
                    Watch(p);
                    if (await Upgrade(p).ConfigureAwait(false)) await Run(p).ConfigureAwait(false);
                }
                catch (Exception) { }
                finally { Finish(p); }
            }

            async Task Respond(Peer p, string status)
            {
                var head = Encoding.ASCII.GetBytes("HTTP/1.1 " + status + "\r\nContent-Type: text/plain; charset=utf-8\r\nContent-Length: 0\r\n" +
                                                   "Cache-Control: no-store\r\nX-Content-Type-Options: nosniff\r\nConnection: close\r\n\r\n");
                await p.Stream.WriteAsync(head, 0, head.Length).ConfigureAwait(false);
            }

            /// The WebSocket handshake. No HTTP pages on the network (no /healthz, no /join).
            async Task<bool> Upgrade(Peer p)
            {
                var head = await p.Reader.Head(64 * 1024).ConfigureAwait(false);
                if (head == null) return false;
                var lines = head.Split(new[] { "\r\n" }, StringSplitOptions.None);
                if (!Regex.IsMatch(lines[0], @"\AGET /\S* HTTP/1\.1\z")) { await Respond(p, "400 Bad Request").ConfigureAwait(false); return false; }
                var headers = new Dictionary<string, string>(StringComparer.OrdinalIgnoreCase);
                foreach (var line in lines.Skip(1))
                {
                    int colon = line.IndexOf(':');
                    if (colon > 0) headers[line.Substring(0, colon).Trim()] = line.Substring(colon + 1).Trim();
                }
                string H(string header) => headers.TryGetValue(header, out var v) ? v : "";
                var key = H("Sec-WebSocket-Key");
                if (!string.Equals(H("Upgrade"), "websocket", StringComparison.OrdinalIgnoreCase) ||
                    H("Connection").IndexOf("upgrade", StringComparison.OrdinalIgnoreCase) < 0 || key.Length == 0)
                { await Respond(p, "404 Not Found").ConfigureAwait(false); return false; }
                bool admitted;
                lock (gate)
                {
                    byAddress.TryGetValue(p.Address, out var n);
                    admitted = n < LanLimits.PerAddress;
                    if (admitted) { byAddress[p.Address] = n + 1; p.Counted = true; }
                }
                if (!admitted) { await Respond(p, "429 Too Many Requests").ConfigureAwait(false); return false; }
                string accept;
                using (var sha1 = SHA1.Create()) accept = Convert.ToBase64String(sha1.ComputeHash(Encoding.ASCII.GetBytes(key).Concat(WebSocketGuid).ToArray()));
                var reply = Encoding.ASCII.GetBytes("HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: " + accept + "\r\n\r\n");
                await p.Stream.WriteAsync(reply, 0, reply.Length).ConfigureAwait(false);
                lock (gate) p.Upgraded = true;
                _ = WriterLoop(p);
                return true;
            }

            /// The join timeout before the join (renewed by info), the idle timeout after it.
            void Watch(Peer p)
            {
                double left;
                bool upgraded, joined;
                lock (gate)
                {
                    if (p.Closing || p.Ended || closed) return;
                    joined = p.Id != null;
                    upgraded = p.Upgraded;
                    left = p.Heard + (joined ? LanLimits.Idle : LanLimits.JoinTimeout) - Now;
                    if (left > 0)
                    {
                        p.Watch?.Dispose();
                        p.Watch = new Timer(_ => Watch(p), null, TimeSpan.FromSeconds(left), Timeout.InfiniteTimeSpan);
                        return;
                    }
                }
                if (upgraded) Close(p, joined ? 1001 : 1008, false); else End(p);
            }

            void Sweep()
            {
                List<Peer> idle = null;
                lock (gate) { if (members.Count > 0 && Now - active > LanLimits.LanRoomIdle) idle = members.Values.ToList(); }
                if (idle != null) foreach (var p in idle) Close(p, 1001, true);
            }

            /// Queues a frame for this peer; past LanLimits.Queue the peer is too far behind and is cut off.
            void Push(Peer p, byte[] data)
            {
                lock (gate)
                {
                    if (p.Closing || p.Ended) return;
                    if (p.Queued + data.Length > LanLimits.Queue) { CloseLocked(p, 1013, true); }
                    else { p.Out.Enqueue(data); p.Queued += data.Length; }
                }
                Release(p);
            }

            void Send(Peer p, Dictionary<string, object> message) => Push(p, Text(message));

            static void Release(Peer p) { try { p.Wake.Release(); } catch (Exception) { } }

            /// A close frame after what is queued (drop: instead of it); the connection ends once it is
            /// written, or after two seconds for a peer that stopped reading.
            void Close(Peer p, int code, bool drop)
            {
                lock (gate) CloseLocked(p, code, drop);
                Release(p);
            }

            void CloseLocked(Peer p, int code, bool drop)
            {
                if (p.Closing || p.Ended) return;
                p.Closing = true;
                if (drop) { p.Out.Clear(); p.Queued = 0; }
                p.Out.Enqueue(Frame(0x8, new[] { (byte)(code >> 8), (byte)code }));
                Task.Delay(2000).ContinueWith(_ => End(p));
            }

            void End(Peer p)
            {
                lock (gate) p.Ended = true;
                try { p.Client.Close(); } catch (Exception) { }
                Release(p);
            }

            async Task WriterLoop(Peer p)
            {
                try
                {
                    while (true)
                    {
                        await p.Wake.WaitAsync().ConfigureAwait(false);
                        while (true)
                        {
                            byte[] data;
                            lock (gate)
                            {
                                if (p.Ended) return;
                                if (p.Out.Count == 0) break;
                                data = p.Out.Dequeue();
                                if (data[0] != 0x88) p.Queued -= data.Length;
                            }
                            await p.Stream.WriteAsync(data, 0, data.Length).ConfigureAwait(false);
                            if (data[0] == 0x88) return;
                        }
                    }
                }
                catch (Exception) { }
                finally { End(p); }
            }

            /// One text message (fragments joined; pings answered). Throws Closed.
            async Task<string> Receive(Peer p)
            {
                var parts = new MemoryStream();
                int opcode = -1;
                long size = 0;
                while (true)
                {
                    var head = await p.Reader.Exact(2).ConfigureAwait(false);
                    bool fin = (head[0] & 0x80) != 0, masked = (head[1] & 0x80) != 0;
                    int op = head[0] & 0x0F;
                    long length = head[1] & 0x7F;
                    if ((head[0] & 0x70) != 0 || !masked) { Close(p, 1002, false); throw new Closed(); }
                    if (length == 126) { var b = await p.Reader.Exact(2).ConfigureAwait(false); length = (b[0] << 8) | b[1]; }
                    else if (length == 127)
                    {
                        var b = await p.Reader.Exact(8).ConfigureAwait(false);
                        if ((b[0] & 0x80) != 0) { Close(p, 1009, false); throw new Closed(); }
                        length = 0;
                        foreach (var x in b) length = (length << 8) | x;
                    }
                    if (length > LanLimits.Frame || size + length > LanLimits.Frame) { Close(p, 1009, false); throw new Closed(); }
                    var mask = await p.Reader.Exact(4).ConfigureAwait(false);
                    var data = await p.Reader.Exact((int)length).ConfigureAwait(false);
                    for (int i = 0; i < data.Length; i++) data[i] ^= mask[i & 3];
                    if (op == 0x8) { Close(p, 1000, false); throw new Closed(); }
                    if (op == 0x9) { Push(p, Frame(0xA, data)); continue; }
                    if (op == 0xA) continue;
                    if (op == 0x1 || op == 0x2)
                    {
                        if (opcode != -1) { Close(p, 1002, false); throw new Closed(); }
                        opcode = op;
                    }
                    else if (op != 0x0 || opcode == -1) { Close(p, 1002, false); throw new Closed(); }
                    parts.Write(data, 0, data.Length);
                    size += length;
                    if (!fin) continue;
                    if (opcode != 0x1) { Close(p, 1003, false); throw new Closed(); }
                    string text;
                    try { text = StrictUtf8.GetString(parts.ToArray()); }
                    catch (DecoderFallbackException) { Close(p, 1007, false); throw new Closed(); }
                    lock (gate) p.Heard = Now;
                    return text;
                }
            }

            /// Per-connection rate: past the budget the sender waits (is not read) until the next window.
            static double Throttle(Peer p, int size)
            {
                double now = Now;
                if (now - p.WindowStart > LanLimits.RateWindow) { p.WindowStart = now; p.WindowCount = 0; p.WindowBytes = 0; }
                p.WindowCount++;
                p.WindowBytes += size;
                if (p.WindowCount <= LanLimits.RateMessages && p.WindowBytes <= LanLimits.RateBytes) return 0;
                double wait = Math.Max(0, p.WindowStart + LanLimits.RateWindow - now);
                p.WindowStart = now + wait;
                p.WindowCount = 1;
                p.WindowBytes = size;
                return wait;
            }

            static bool Admit(Dictionary<string, Queue<double>> log, string address, int limit, double seconds)
            {
                double now = Now;
                if (log.Count > 1024) foreach (var k in log.Where(e => e.Value.Count == 0 || now - e.Value.Last() > seconds).Select(e => e.Key).ToList()) log.Remove(k);
                if (!log.TryGetValue(address, out var times)) log[address] = times = new Queue<double>();
                while (times.Count > 0 && now - times.Peek() > seconds) times.Dequeue();
                if (times.Count >= limit) return false;
                times.Enqueue(now);
                return true;
            }

            static string NewId()
            {
                var bytes = new byte[8];
                using (var random = RandomNumberGenerator.Create()) random.GetBytes(bytes);
                return "c" + Hex(bytes);
            }

            void Refuse(Peer p, string why, int code = 1008)
            {
                Send(p, new Dictionary<string, object> { { "t", "error" }, { "e", why } });
                Close(p, code, false);
            }

            static Dictionary<string, object> Parse(string text)
            {
                try { return Json.Parse(text) as Dictionary<string, object> ?? new Dictionary<string, object>(); }
                catch (Exception) { return null; }
            }

            /// The session: info (once), the join, then messages until the connection ends.
            async Task Run(Peer p)
            {
                var join = Parse(await Receive(p).ConfigureAwait(false));
                if (join != null && Str(join, "t") == "info")
                {
                    Send(p, new Dictionary<string, object> { { "t", "info" }, { "v", 2 }, { "salt", salt }, { "name", name }, { "host", Host } });
                    join = Parse(await Receive(p).ConfigureAwait(false));
                }
                if (join == null) { Close(p, 1008, false); return; }
                string r = Str(join, "room"), auth = Str(join, "auth"), own = Str(join, "own");
                if (Str(join, "t") != "join" || r == null || auth == null || !Hex64.IsMatch(r) || !Hex64.IsMatch(auth) || Sha256(FromHex(auth)) != r)
                { Refuse(p, "The room key does not match this room."); return; }
                if (r != room) { Refuse(p, "This Waffle session is not shared here any more."); return; }
                var ownHash = own != null && own.Length >= 16 && own.Length <= 128 ? Sha256(Encoding.UTF8.GetBytes(own)) : null;
                string refusal = null, id = null;
                List<Peer> others = null;
                lock (gate)
                {
                    bool exists = members.Count > 0;
                    if (!Admit(joins, p.Address, LanLimits.Joins, 60)) refusal = "Too many joins from this address; try again in a minute.";
                    else if (exists && !(ownHash != null && ownHash == owner) && !Admit(roomJoins, p.Address, LanLimits.RoomJoins, 600))
                        refusal = "Too many joins into this session from this address; try again in a few minutes.";
                    else
                    {
                        // The owner is the first joiner with an owner token for as long as the session is shared.
                        if (!exists) { if (owner == null) owner = ownHash; active = Now; }
                        bool isOwner = ownHash != null && ownHash == owner;
                        if (exists && members.Count >= LanLimits.Peers + (isOwner ? 2 : 0)) refusal = "full";
                        else
                        {
                            others = members.Values.ToList();
                            id = NewId();
                            members[id] = p;
                            p.Id = id;
                            p.Owner = isOwner;
                            // Queued under the lock (Push never blocks), so no message, join or leave
                            // can reach anyone ahead of these, as on the relay.
                            Send(p, new Dictionary<string, object> {
                                { "t", "joined" }, { "v", 2 }, { "id", id }, { "peers", others.Select(o => (object)o.Id).ToList() },
                                { "ice", new List<object>() }, { "ttl", 3600 }, { "owner", isOwner },
                            });
                            foreach (var o in others)
                            {
                                Send(o, new Dictionary<string, object> { { "t", "peer" }, { "id", id }, { "joined", true } });
                                Send(o, new Dictionary<string, object> { { "t", "peers" }, { "n", others.Count } });
                            }
                        }
                    }
                }
                if (refusal == "full") { Refuse(p, "This room is full.", 1013); return; }
                if (refusal != null) { Refuse(p, refusal); return; }
                Watch(p);   // the idle timeout from now on
                while (true)
                {
                    var text = await Receive(p).ConfigureAwait(false);
                    double wait = Throttle(p, text.Length);
                    if (wait > 0) await Task.Delay(TimeSpan.FromSeconds(wait)).ConfigureAwait(false);
                    if (p.Closing) return;
                    Dictionary<string, object> msg;
                    try { msg = Json.Parse(text) as Dictionary<string, object>; } catch (Exception) { continue; }
                    if (msg == null) continue;
                    var kind = Str(msg, "t");
                    if (kind == "m" && Str(msg, "d") is string d) await Forward(p, msg, d).ConfigureAwait(false);
                    else if (kind == "sig" && Str(msg, "d") is string signal && CodePoints(signal) <= LanLimits.Signal && Str(msg, "to") is string to)
                    {
                        Peer other = null;
                        lock (gate) { if (members.TryGetValue(to, out other) && other != p) active = Now; else other = null; }
                        if (other != null) Send(other, new Dictionary<string, object> { { "t", "sig" }, { "from", id }, { "d", signal } });
                    }
                    // Keepalives ("p"), attestations and TURN requests: nothing to do here.
                }
            }

            static int CodePoints(string s)
            {
                int n = 0;
                foreach (var c in s) if (!char.IsLowSurrogate(c)) n++;
                return n;
            }

            /// To everyone else, or to named peers (each once); then wait while a recipient is behind.
            async Task Forward(Peer p, Dictionary<string, object> msg, string d)
            {
                List<Peer> targets;
                lock (gate)
                {
                    if (msg.TryGetValue("to", out var to) && to is List<object> list)
                        targets = list.Take(64).OfType<string>().Distinct().Where(c => c != p.Id && members.ContainsKey(c)).Select(c => members[c]).ToList();
                    else targets = members.Values.Where(o => o != p).ToList();
                    active = Now;
                }
                if (targets.Count == 0) return;
                var frame = Text(new Dictionary<string, object> { { "t", "m" }, { "d", d }, { "from", p.Id } });
                foreach (var o in targets) Push(o, frame);
                // Stop reading the sender while a recipient is more than QueueSoft behind; a recipient that
                // stays behind for Stall is cut off, so it cannot hold the room back for long.
                double deadline = Now + LanLimits.Stall;
                foreach (var o in targets)
                {
                    while (true)
                    {
                        bool behind;
                        lock (gate) behind = !o.Closing && !o.Ended && o.Queued > LanLimits.QueueSoft;
                        if (!behind) break;
                        if (Now >= deadline) { Close(o, 1013, true); break; }
                        await Task.Delay(20).ConfigureAwait(false);
                    }
                }
            }

            /// The connection ended: it leaves the room (announced) and its counts are returned.
            void Finish(Peer p)
            {
                List<Peer> others = null;
                string id;
                bool closing;
                lock (gate)
                {
                    all.Remove(p);
                    if (p.Counted)
                    {
                        p.Counted = false;
                        if (byAddress.TryGetValue(p.Address, out var n) && n > 1) byAddress[p.Address] = n - 1; else byAddress.Remove(p.Address);
                    }
                    p.Watch?.Dispose();
                    p.Watch = null;
                    id = p.Id;
                    if (id != null && members.Remove(id)) others = members.Values.ToList();
                    closing = p.Closing || p.Ended;
                    if (others != null)
                        foreach (var o in others)
                        {
                            Send(o, new Dictionary<string, object> { { "t", "peer" }, { "id", id }, { "joined", false } });
                            Send(o, new Dictionary<string, object> { { "t", "peers" }, { "n", others.Count - 1 } });
                        }
                }
                if (!closing && p.Upgraded) Close(p, 1000, false); else if (!closing) End(p);
            }
        }
    }
}
