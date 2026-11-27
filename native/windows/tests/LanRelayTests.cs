// The Windows LAN listener (src/Core/LanRelay.cs): which adapters count as this network, the bridge
// actions through Host, and --lan-relay, the driver that native/tests/lan_relay.py runs its
// conformance suite against (the same suite as the macOS and Linux listeners).
using System;
using System.Collections.Generic;
using System.IO;
using System.Linq;
using System.Net;
using System.Net.NetworkInformation;
using System.Net.Sockets;

namespace Waffle.Windows.Tests
{
    sealed class FakeDiscovery : ILanDiscovery
    {
        public string Advertised;
        public bool Withdrawn, Fail;
        public IList<LanFound> Found = new List<LanFound>();
        public bool Advertise(string name, int port) { Advertised = name + ":" + port; Withdrawn = false; return true; }
        public void Withdraw() => Withdrawn = true;
        public IList<LanFound> Browse(TimeSpan timeout) { if (Fail) throw new InvalidOperationException("DnsServiceBrowse failed: 1"); return Found; }
    }

    static partial class Program
    {
        /// The driver contract of native/tests/lan_relay.py: argv ROOM SALT; WAFFLE_LAN_LIMITS; prints
        /// PORT and REPLY lines; "host ID" lines call lanHost, any other line stops (REPLY, STOPPED).
        static int LanRelayDriver(string room, string salt)
        {
            var limits = Environment.GetEnvironmentVariable("WAFFLE_LAN_LIMITS");
            if (!string.IsNullOrEmpty(limits))
                foreach (var pair in (Dictionary<string, object>)Json.Parse(limits))
                    if (!(pair.Value is double value) || !LanLimits.Set(pair.Key, value)) { Console.WriteLine("ERROR limit " + pair.Key); return 1; }
            var lan = new LanRelay(loopbackOnly: true);
            Dictionary<string, object> started;
            try { started = lan.Start(room, salt, "Board  review"); }
            catch (HostError e) { Console.WriteLine("ERROR " + e.Message); return 1; }
            Console.WriteLine("PORT " + started["port"] + " " + started["name"]);
            Console.WriteLine("REPLY " + Json.Write(started));
            Console.Out.Flush();
            string line;
            while ((line = Console.ReadLine()) != null && line.StartsWith("host ", StringComparison.Ordinal))
            {
                Console.WriteLine("REPLY " + Json.Write(lan.SetHost(line.Substring(5))));
                Console.Out.Flush();
            }
            Console.WriteLine("REPLY " + Json.Write(lan.Stop()));
            Console.WriteLine("STOPPED");
            Console.Out.Flush();
            return 0;
        }

        static LanInterface Adapter(string name, string description, NetworkInterfaceType type, bool hardware, bool gateway, params string[] addresses) =>
            new LanInterface { Name = name, Description = description, Type = type, Up = true, Hardware = hardware, Gateway = gateway,
                               Addresses = addresses.Select(a => IPAddress.Parse(a)).ToList() };

        static bool LanListening(int port)
        {
            try { using (var c = new TcpClient()) { c.Connect(IPAddress.Loopback, port); return true; } }
            catch (SocketException) { return false; }
        }

        static void LanTests(string scratch)
        {
            group = "lan";
            var adapters = new List<LanInterface> {
                Adapter("Wi-Fi", "Intel(R) Wi-Fi 6 AX201 160MHz", NetworkInterfaceType.Wireless80211, true, false, "192.168.1.20", "fe80::1", "fd12:3456::7"),
                Adapter("Ethernet", "Realtek PCIe GbE Family Controller", NetworkInterfaceType.Ethernet, true, true, "203.0.113.9", "10.1.2.3"),
                Adapter("vEthernet (WSL)", "Hyper-V Virtual Ethernet Adapter", NetworkInterfaceType.Ethernet, false, false, "172.20.0.1"),
                // Named virtual even where Windows would call it hardware.
                Adapter("vEthernet (Default Switch)", "Hyper-V Virtual Ethernet Adapter #2", NetworkInterfaceType.Ethernet, true, false, "172.21.0.1"),
                Adapter("OpenVPN", "TAP-Windows Adapter V9", NetworkInterfaceType.Ethernet, true, true, "10.8.0.6"),
                Adapter("wg0", "WireGuard Tunnel", NetworkInterfaceType.Unknown, false, true, "10.66.0.2"),
                Adapter("Tailscale", "Tailscale Tunnel", NetworkInterfaceType.Unknown, false, false, "100.101.102.103"),
                Adapter("VirtualBox Host-Only Network", "VirtualBox Host-Only Ethernet Adapter", NetworkInterfaceType.Ethernet, true, false, "192.168.56.1"),
                Adapter("Bluetooth Network Connection", "Bluetooth Device (Personal Area Network)", NetworkInterfaceType.Ethernet, true, false, "192.168.44.1"),
                Adapter("Local Area Connection* 2", "Microsoft Wi-Fi Direct Virtual Adapter", NetworkInterfaceType.Wireless80211, true, false, "192.168.137.1"),
                Adapter("Loopback Pseudo-Interface 1", "Software Loopback Interface 1", NetworkInterfaceType.Loopback, false, false, "127.0.0.1", "::1"),
                Adapter("Cellular", "Mobile Broadband", NetworkInterfaceType.Wwanpp, true, true, "10.200.0.4"),
            };
            var down = Adapter("Ethernet 2", "ASIX USB Ethernet", NetworkInterfaceType.Ethernet, true, false, "192.168.9.9");
            down.Up = false;
            adapters.Add(down);
            var addresses = LanNetworks.Addresses(adapters);
            Check(addresses.SequenceEqual(new[] { "10.1.2.3", "192.168.1.20", "fd12:3456::7" }),
                  "private addresses of physical Wi-Fi and Ethernet only; the default gateway's adapter first, IPv4 before IPv6: " + string.Join(",", addresses));
            Check(LanNetworks.Addresses(adapters.Where(a => a.Name.StartsWith("vEthernet") || a.Name == "OpenVPN" || a.Name == "wg0").ToList()).Count == 0,
                  "Hyper-V, WSL and VPN adapters alone are no local network");
            Check(LanNetworks.Private(IPAddress.Parse("172.31.255.1")) && !LanNetworks.Private(IPAddress.Parse("172.32.0.1")) &&
                  !LanNetworks.Private(IPAddress.Parse("100.64.0.1")) && !LanNetworks.Private(IPAddress.Parse("169.254.1.1")) &&
                  !LanNetworks.Private(IPAddress.Parse("::ffff:192.168.1.1")) && !LanNetworks.Private(IPAddress.Parse("fe80::1")) &&
                  LanNetworks.Private(IPAddress.Parse("fd00::1")) && !LanNetworks.Private(IPAddress.Parse("2001:db8::1")), "private ranges");

            // What a search found becomes the sessions every host lists.
            var sessions = LanRelay.Sessions(new[] {
                new LanFound { Name = "board review", Address = "192.168.1.20", Port = 48765 },
                new LanFound { Name = "Board review", Address = "fe80::1", Port = 48765 },
                new LanFound { Name = "Board review", Address = "fd12::5", Port = 48765 },
                new LanFound { Name = "Board review", Address = "192.168.1.21", Port = 48765 },
                new LanFound { Name = "Board review", Address = "192.168.1.21", Port = 48765 },
                new LanFound { Name = "Analog", Address = "not an address", Port = 1 },
                new LanFound { Name = "Analog", Address = "10.0.0.2", Port = 0 },
            });
            Check(Json.Write(sessions) == "[{\"address\":\"192.168.1.20\",\"name\":\"board review\",\"port\":48765}," +
                  "{\"address\":\"192.168.1.21\",\"name\":\"Board review\",\"port\":48765},{\"address\":\"fd12::5\",\"name\":\"Board review\",\"port\":48765}]",
                  "sessions by name, IPv4 first, no link-local, no repeats: " + Json.Write(sessions));

            var room = new string('a', 64);
            var salt = new string('S', 22);
            var relay = new LanRelay(loopbackOnly: true);
            Throws(() => relay.Start("nope", salt, "x"), "Not a session id.", "a bad session id");
            Throws(() => relay.Start(room, "short", "x"), "Not a session salt.", "a bad salt");
            Throws(() => new LanRelay(null, () => adapters.Where(a => !a.Hardware)).Start(room, salt, "x"), "not on a local network", "no physical adapter");
            Throws(() => new LanRelay().Start(room, salt, "x"), "not on a local network", "a relay given no adapters finds no network");

            var fake = new FakeDiscovery();
            relay = new LanRelay(fake, null, loopbackOnly: true);
            var started = relay.Start(room, salt, "  Board \n review  ");
            var port = (int)started["port"];
            Check(Json.Write(started) == "{\"addresses\":[],\"advertised\":true,\"name\":\"Board review\",\"port\":" + port + ",\"primary\":null}",
                  "lanStart's reply: " + Json.Write(started));
            Check(fake.Advertised == "Board review:" + port, "announced with the session name and port only");
            Check(LanListening(port), "listening on loopback");
            Check(Json.Write(relay.SetHost("peer-0123")) == "{\"ok\":true}", "lanHost");
            Check(Json.Write(relay.Stop()) == "{\"stopped\":true}" && fake.Withdrawn, "lanStop withdraws the announcement");
            Check(!LanListening(port), "nothing listens after lanStop");
            Check(Json.Write(relay.SetHost("peer-0123")) == "{\"ok\":false}", "lanHost with nothing shared");
            fake.Found = new List<LanFound> { new LanFound { Name = "Bench", Address = "192.168.1.30", Port = 48765 } };
            Check(Json.Write(relay.Browse()) == "{\"sessions\":[{\"address\":\"192.168.1.30\",\"name\":\"Bench\",\"port\":48765}]}", "lanBrowse's reply");
            fake.Fail = true;
            Throws(() => relay.Browse(), "type the host's address", "a failed search asks for the address");
            Throws(() => new LanRelay().Browse(), "type the host's address", "without DNS-SD, Find Sessions asks for the address");

            // Through the bridge: the replies, and a reloaded page stops the listener.
            var ui = new FakeUi();
            var host = new Host(new PortableFs(), ui, new FakeGit(), Directory.CreateDirectory(Path.Combine(scratch, "lan-support")).FullName, testTranslators);
            fake = new FakeDiscovery();
            host.Lan = new LanRelay(fake, null, loopbackOnly: true);
            host.Receive(Policy.PageUri, Msg("id", 1, "action", "lanStart", "room", room, "salt", salt, "name", "Bench"));
            host.WaitForCollab();
            var reply = ui.Last;
            var result = reply["result"] as Dictionary<string, object>;
            Check(reply["error"] == null && result != null && (string)result["name"] == "Bench" && result.ContainsKey("primary"), "lanStart through the bridge");
            port = result == null ? 0 : (int)(double)result["port"];
            host.Receive(Policy.PageUri, Msg("id", 2, "action", "lanHost", "host", "peer-0123"));
            host.WaitForCollab();
            Check(Json.Write(ui.Last["result"]) == "{\"ok\":true}", "lanHost through the bridge");
            host.PageGone();
            host.WaitForCollab();
            Check(!host.Lan.Running && !LanListening(port) && fake.Withdrawn, "a reloaded page stops the listener and its announcement");
            host.Receive(Policy.PageUri, Msg("id", 3, "action", "lanStop"));
            host.WaitForCollab();
            Check(Json.Write(ui.Last["result"]) == "{\"stopped\":true}", "lanStop through the bridge");
            host.Receive(Policy.PageUri, Msg("id", 4, "action", "lanBrowse"));
            Check(Json.Write(ui.Last["result"]) == "{\"sessions\":[]}", "lanBrowse through the bridge");
            host.Receive(Policy.PageUri, Msg("id", 5, "action", "lanStart", "room", "x", "salt", salt, "name", "Bench"));
            host.WaitForCollab();
            Check((string)ui.Last["error"] == "Not a session id.", "lanStart's errors reach the page");
            host.Closing();
            LanSocketTests(scratch, room, salt);
        }

        static Dictionary<string, object> Await(Func<Dictionary<string, object>> found, string what)
        {
            var until = DateTime.UtcNow.AddSeconds(5);
            while (DateTime.UtcNow < until)
            {
                var hit = found();
                if (hit != null) return hit;
                System.Threading.Thread.Sleep(10);
            }
            Check(false, what + " (timed out)");
            return null;
        }

        /// The host's WebSocket for the page (LanSockets.cs): only ws:// to loopback or a private address,
        /// against the C# listener itself on loopback, and through the bridge actions.
        static void LanSocketTests(string scratch, string room, string salt)
        {
            group = "lan sockets";
            Check(LanSockets.Target("ws://127.0.0.1:48765").ToString() == "ws://127.0.0.1:48765/" &&
                  LanSockets.Target("ws://192.168.1.20:48765/").ToString() == "ws://192.168.1.20:48765/" &&
                  LanSockets.Target("ws://[fd12::7]:48765").ToString() == "ws://[fd12::7]:48765/", "loopback and private addresses");
            foreach (var url in new[] { "wss://192.168.1.20:48765", "http://192.168.1.20:48765", "ws://8.8.8.8:48765", "ws://203.0.113.9:48765",
                                        "ws://example.com:48765", "ws://192.168.1.20:48765/x", "ws://192.168.1.20:48765/?q", "ws://a:b@192.168.1.20:48765",
                                        "ws://[fe80::1]:48765", "ws://169.254.1.1:48765", "javascript:1", "", null })
                Throws(() => LanSockets.Target(url), "only to ws:// addresses", "refused: " + url);

            var relay = new LanRelay(loopbackOnly: true);
            var port = (int)relay.Start(room, salt, "Bench")["port"];
            var events = new List<Dictionary<string, object>>();
            Action<Dictionary<string, object>> collect = e => { lock (events) events.Add(e); };
            Func<string, Dictionary<string, object>> message = t => { lock (events) return events.FirstOrDefault(e => (string)e["event"] == "message" && ((string)e["data"]).Contains("\"t\":\"" + t + "\"")); };
            var sockets = new LanSockets();
            var id = sockets.Connect("ws://127.0.0.1:" + port, collect).GetAwaiter().GetResult();
            sockets.Run(id);
            Check(sockets.Send(id, "{\"t\":\"info\"}"), "send");
            var info = Await(() => message("info"), "info through the host's socket");
            Check(info != null && ((string)info["data"]).Contains("\"name\":\"Bench\"") && (int)info["socket"] == id && (string)info["type"] == "lanSocket", "the listener answers info");
            Check(Await(() => { lock (events) return events.FirstOrDefault(e => (string)e["event"] == "drain"); }, "drain") != null, "a sent message is reported as drained");
            sockets.Send(id, "{\"t\":\"info\"}");   // a second info is no join: refused and closed
            Check(Await(() => { lock (events) return events.FirstOrDefault(e => (string)e["event"] == "close"); }, "close") != null && sockets.Count == 0,
                  "the listener's close reaches the page");
            try { sockets.Connect("ws://127.0.0.1:9", collect).GetAwaiter().GetResult(); Check(false, "nothing listens on port 9"); }
            catch (HostError e) { Check(e.Message.StartsWith("No Waffle session answered at 127.0.0.1:9"), "nothing answered: " + e.Message); }

            // Through the bridge: lanConnect replies with the socket; lanSend, events; a reload closes them all.
            var ui = new FakeUi();
            var host = new Host(new PortableFs(), ui, new FakeGit(), Directory.CreateDirectory(Path.Combine(scratch, "lan-socket-support")).FullName, testTranslators);
            host.Receive(Policy.PageUri, Msg("id", 1, "action", "lanConnect", "url", "ws://127.0.0.1:" + port));
            Func<int, Dictionary<string, object>> reply = n => { lock (ui.Posts) return ui.Posts.FirstOrDefault(p => p.TryGetValue("id", out var v) && v is double d && d == n); };
            var connected = Await(() => reply(1), "lanConnect's reply");
            var socket = connected?["result"] as Dictionary<string, object>;
            Check(socket != null && socket["socket"] is double, "lanConnect: {socket}");
            if (socket != null)
            {
                host.Receive(Policy.PageUri, Msg("action", "lanSend", "socket", socket["socket"], "data", "{\"t\":\"info\"}"));
                Check(Await(() => { lock (ui.Posts) return ui.Posts.FirstOrDefault(p => Equals(p.GetValueOrDefault("type"), "lanSocket") && Equals(p.GetValueOrDefault("event"), "message")); },
                            "a message event") != null, "the page gets the listener's answer");
                host.Receive(Policy.PageUri, Msg("action", "lanSend", "socket", 99.0, "data", "x"));   // no such socket: ignored
            }
            host.Receive(Policy.PageUri, Msg("id", 2, "action", "lanConnect", "url", "ws://8.8.8.8:48765"));
            var refused = Await(() => reply(2), "refused lanConnect");
            Check(refused != null && ((string)refused["error"]).Contains("only to ws:// addresses"), "lanConnect refuses other addresses");
            host.Receive(Policy.PageUri, Msg("id", 3, "action", "lanConnect", "url", "ws://127.0.0.1:" + port));
            Await(() => reply(3), "a second socket");
            int before;
            lock (ui.Posts) before = ui.Posts.Count;
            host.PageGone();
            System.Threading.Thread.Sleep(300);
            lock (ui.Posts) Check(ui.Posts.Skip(before).All(p => !Equals(p.GetValueOrDefault("type"), "lanSocket")), "a reloaded page hears nothing from its old sockets");
            host.Closing();
            relay.Stop();
        }
    }
}
