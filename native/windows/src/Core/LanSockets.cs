// WebSockets to this computer and the local network, opened by the host for the page (native/bridge.js
// lanSocket). WebView2 serves the editor from https://app.waffle.example, and a secure page cannot
// open ws:// to loopback or a private address itself (mixed content; local network access checks):
// the host's own window joining its listener and a guest joining a host by address both come here.
// Only ws:// to loopback or a private address (a .local name must resolve to one), text messages,
// a few sockets per page, all closed when the page goes. The page sees the socket shape of
// app/project/collab-pair.js socketClass: open, message, drain (bytes sent) and close events.
using System;
using System.Collections.Generic;
using System.IO;
using System.Linq;
using System.Net;
using System.Net.Sockets;
using System.Net.WebSockets;
using System.Text;
using System.Threading;
using System.Threading.Tasks;

namespace Waffle.Windows
{
    public sealed class LanSockets
    {
        public const int MaxSockets = 8;
        public static int MaxMessage = 4 << 20, MaxQueued = 32 << 20;

        sealed class Conn
        {
            public ClientWebSocket Socket;
            public Action<Dictionary<string, object>> Events;
            public readonly Queue<string> Out = new Queue<string>();
            public long Queued;
            public readonly SemaphoreSlim Wake = new SemaphoreSlim(0);
            public readonly CancellationTokenSource Stop = new CancellationTokenSource();
            public bool Closed;
        }

        readonly object gate = new object();
        readonly Dictionary<int, Conn> open = new Dictionary<int, Conn>();
        int next;

        static bool Allowed(IPAddress ip) => ip != null && (IPAddress.IsLoopback(ip) || LanNetworks.Private(ip));

        /// The address to connect to: ws://<loopback or private address>:<port>/, nothing else.
        public static Uri Target(string url)
        {
            const string refused = "Waffle connects only to ws:// addresses on this computer or the local network.";
            if (url == null || url.Length > 300 || !Uri.TryCreate(url, UriKind.Absolute, out var uri) || uri.Scheme != "ws" ||
                uri.UserInfo.Length > 0 || uri.Query.Length > 0 || uri.Fragment.Length > 0 || uri.AbsolutePath != "/" || uri.Port <= 0 || uri.Port > 65535)
                throw new HostError(refused);
            var host = uri.DnsSafeHost;
            IPAddress ip;
            if (!IPAddress.TryParse(host, out ip))
            {
                if (!host.EndsWith(".local", StringComparison.OrdinalIgnoreCase)) throw new HostError(refused);
                try { ip = Dns.GetHostAddresses(host).FirstOrDefault(Allowed); }
                catch (SocketException) { ip = null; }
                if (ip == null) throw new HostError("No Waffle session answered at " + host + ".");
            }
            if (!Allowed(ip)) throw new HostError(refused);
            var literal = ip.AddressFamily == AddressFamily.InterNetworkV6 ? "[" + new IPAddress(ip.GetAddressBytes()) + "]" : ip.ToString();
            return new Uri("ws://" + literal + ":" + uri.Port + "/");
        }

        /// Connects (at most six seconds); the socket's id. events receives each event for the page,
        /// on any thread, in order, once Run starts it.
        public async Task<int> Connect(string url, Action<Dictionary<string, object>> events)
        {
            var target = Target(url);
            lock (gate) if (open.Count >= MaxSockets) throw new HostError("Too many connections to this network are open.");
            var socket = new ClientWebSocket();
            try
            {
                using (var timeout = new CancellationTokenSource(TimeSpan.FromSeconds(6)))
                    await socket.ConnectAsync(target, timeout.Token).ConfigureAwait(false);
            }
            catch (Exception)
            {
                socket.Dispose();
                throw new HostError("No Waffle session answered at " + target.Authority + ".");
            }
            lock (gate)
            {
                var id = ++next;
                open[id] = new Conn { Socket = socket, Events = events };
                return id;
            }
        }

        /// Starts delivering a connected socket's events (after the page has its id).
        public void Run(int id)
        {
            Conn c;
            lock (gate) if (!open.TryGetValue(id, out c)) return;
            _ = Read(id, c);
            _ = Write(id, c);
        }

        public bool Send(int id, string data)
        {
            Conn c;
            bool over = false;
            lock (gate)
            {
                if (data == null || !open.TryGetValue(id, out c)) return false;
                if (c.Queued + data.Length > MaxQueued) over = true;   // the other end stopped reading
                else { c.Out.Enqueue(data); c.Queued += data.Length; }
            }
            if (over) { Close(id); return false; }
            try { c.Wake.Release(); } catch (Exception) { }
            return true;
        }

        /// Closes one socket; the page hears "close" unless it asked for it.
        public void Close(int id, bool tell = true)
        {
            Conn c;
            lock (gate)
            {
                if (!open.TryGetValue(id, out c)) return;
                open.Remove(id);
                c.Closed = true;
            }
            try { c.Stop.Cancel(); } catch (Exception) { }
            try { c.Socket.Abort(); } catch (Exception) { }
            try { c.Socket.Dispose(); } catch (Exception) { }
            try { c.Wake.Release(); } catch (Exception) { }
            if (tell) c.Events?.Invoke(Event(id, "close"));
        }

        /// The page went away (reload, failure, close): every socket closes, silently.
        public void CloseAll()
        {
            List<int> ids;
            lock (gate) ids = open.Keys.ToList();
            foreach (var id in ids) Close(id, false);
        }

        public int Count { get { lock (gate) return open.Count; } }

        static Dictionary<string, object> Event(int id, string kind) =>
            new Dictionary<string, object> { { "type", "lanSocket" }, { "socket", id }, { "event", kind } };

        async Task Read(int id, Conn c)
        {
            var buffer = new byte[64 * 1024];
            var message = new MemoryStream();
            try
            {
                while (true)
                {
                    var r = await c.Socket.ReceiveAsync(new ArraySegment<byte>(buffer), c.Stop.Token).ConfigureAwait(false);
                    if (r.MessageType != WebSocketMessageType.Text) break;   // a close, or binary: the relay protocol is text
                    message.Write(buffer, 0, r.Count);
                    if (message.Length > MaxMessage) break;
                    if (!r.EndOfMessage) continue;
                    var text = Encoding.UTF8.GetString(message.ToArray());
                    message.SetLength(0);
                    lock (gate) if (c.Closed) return;
                    var e = Event(id, "message");
                    e["data"] = text;
                    c.Events?.Invoke(e);
                }
            }
            catch (Exception) { }
            Close(id);
        }

        async Task Write(int id, Conn c)
        {
            try
            {
                while (true)
                {
                    await c.Wake.WaitAsync(c.Stop.Token).ConfigureAwait(false);
                    while (true)
                    {
                        string data;
                        lock (gate)
                        {
                            if (c.Closed) return;
                            if (c.Out.Count == 0) break;
                            data = c.Out.Dequeue();
                            c.Queued -= data.Length;
                        }
                        var bytes = Encoding.UTF8.GetBytes(data);
                        await c.Socket.SendAsync(new ArraySegment<byte>(bytes), WebSocketMessageType.Text, true, c.Stop.Token).ConfigureAwait(false);
                        var e = Event(id, "drain");
                        e["bytes"] = data.Length;
                        c.Events?.Invoke(e);
                    }
                }
            }
            catch (Exception) { }
            Close(id);
        }
    }
}
