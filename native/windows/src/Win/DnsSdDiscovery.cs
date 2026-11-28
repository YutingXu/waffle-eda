// DNS-SD for same-network sessions (LanRelay.cs) with what Windows 10 1903+ ships: dnsapi.dll's
// DnsServiceRegister, DnsServiceBrowse and DnsServiceResolve. It announces _waffle._tcp with the
// session's display name, the port and "v=2", under this computer's existing name, as Bonjour (macOS)
// and avahi (Linux) do. Any failure degrades: lanStart reports advertised: false, and Find Sessions
// says to type the host's address. Not testable off Windows; see docs/windows.md for the hand checks.
using System;
using System.Collections.Generic;
using System.Net;
using System.Runtime.InteropServices;
using System.Threading;

namespace Waffle.Windows
{
    sealed class DnsSdDiscovery : ILanDiscovery
    {
        const int DnsRequestPending = 9506, QueryRequestVersion1 = 1, DnsTypePtr = 12, DnsFreeRecordList = 1;
        const string Domain = LanRelay.Service + ".local";

        [StructLayout(LayoutKind.Sequential)]
        struct ServiceInstance
        {
            public IntPtr InstanceName, HostName, Ip4Address, Ip6Address;
            public ushort Port, Priority, Weight;
            public uint PropertyCount;
            public IntPtr Keys, Values;
            public uint InterfaceIndex;
        }

        [StructLayout(LayoutKind.Sequential)]
        struct RegisterRequest
        {
            public uint Version, InterfaceIndex;
            public IntPtr ServiceInstance, Callback, Context, Credentials;
            public int UnicastEnabled;
        }

        // DNS_SERVICE_BROWSE_REQUEST and DNS_SERVICE_RESOLVE_REQUEST share this layout (version 1).
        [StructLayout(LayoutKind.Sequential)]
        struct QueryRequest
        {
            public uint Version, InterfaceIndex;
            public IntPtr QueryName, Callback, Context;
        }

        [UnmanagedFunctionPointer(CallingConvention.Winapi)] delegate void InstanceCallback(uint status, IntPtr context, IntPtr instance);
        [UnmanagedFunctionPointer(CallingConvention.Winapi)] delegate void BrowseCallback(uint status, IntPtr context, IntPtr records);

        [DllImport("dnsapi.dll", CharSet = CharSet.Unicode, ExactSpelling = true)]
        static extern IntPtr DnsServiceConstructInstance(string serviceName, string hostName, IntPtr ip4, IntPtr ip6, ushort port, ushort priority, ushort weight,
            uint propertiesCount, [MarshalAs(UnmanagedType.LPArray, ArraySubType = UnmanagedType.LPWStr)] string[] keys,
            [MarshalAs(UnmanagedType.LPArray, ArraySubType = UnmanagedType.LPWStr)] string[] values);
        [DllImport("dnsapi.dll", ExactSpelling = true)] static extern void DnsServiceFreeInstance(IntPtr instance);
        [DllImport("dnsapi.dll", ExactSpelling = true)] static extern int DnsServiceRegister(IntPtr request, IntPtr cancel);
        [DllImport("dnsapi.dll", ExactSpelling = true)] static extern int DnsServiceDeRegister(IntPtr request, IntPtr cancel);
        [DllImport("dnsapi.dll", ExactSpelling = true)] static extern int DnsServiceBrowse(IntPtr request, IntPtr cancel);
        [DllImport("dnsapi.dll", ExactSpelling = true)] static extern int DnsServiceBrowseCancel(IntPtr cancel);
        [DllImport("dnsapi.dll", ExactSpelling = true)] static extern int DnsServiceResolve(IntPtr request, IntPtr cancel);
        [DllImport("dnsapi.dll", ExactSpelling = true)] static extern int DnsServiceResolveCancel(IntPtr cancel);
        [DllImport("dnsapi.dll", ExactSpelling = true)] static extern void DnsFree(IntPtr data, int freeType);

        // Callbacks and the memory dnsapi may still use stay referenced until it is done with them.
        static readonly List<object> keepAlive = new List<object>();
        readonly object gate = new object();
        IntPtr registration, instance;

        static IntPtr Struct<T>(T value)
        {
            var memory = Marshal.AllocHGlobal(Marshal.SizeOf<T>());
            Marshal.StructureToPtr(value, memory, false);
            return memory;
        }

        static IntPtr Zeroed(int size)
        {
            var memory = Marshal.AllocHGlobal(size);
            for (int i = 0; i < size; i++) Marshal.WriteByte(memory, i, 0);
            return memory;
        }

        public bool Advertise(string name, int port)
        {
            Withdraw();
            IntPtr made = IntPtr.Zero, request = IntPtr.Zero;
            try
            {
                // A dot would end the instance label: the announced name uses a one-dot leader instead.
                var label = name.Replace('.', '․');
                made = DnsServiceConstructInstance(label + "." + Domain, Dns.GetHostName() + ".local", IntPtr.Zero, IntPtr.Zero,
                                                   (ushort)port, 0, 0, 1, new[] { "v" }, new[] { "2" });
                if (made == IntPtr.Zero) return false;
                InstanceCallback done = (status, context, registered) =>
                {
                    try { if (registered != IntPtr.Zero && registered != made) DnsServiceFreeInstance(registered); } catch (Exception) { }
                };
                lock (keepAlive) keepAlive.Add(done);
                request = Struct(new RegisterRequest { Version = QueryRequestVersion1, ServiceInstance = made, Callback = Marshal.GetFunctionPointerForDelegate(done) });
                if (DnsServiceRegister(request, IntPtr.Zero) != DnsRequestPending)
                {
                    DnsServiceFreeInstance(made);
                    Marshal.FreeHGlobal(request);
                    return false;
                }
                lock (gate) { registration = request; instance = made; }
                return true;
            }
            catch (Exception e) when (e is DllNotFoundException || e is EntryPointNotFoundException)
            {
                // Before Windows 10 1903: no DNS-SD. Guests type the address.
                if (request != IntPtr.Zero) Marshal.FreeHGlobal(request);
                return false;
            }
        }

        public void Withdraw()
        {
            IntPtr request, made;
            lock (gate) { request = registration; made = instance; registration = instance = IntPtr.Zero; }
            if (request == IntPtr.Zero) return;
            try
            {
                // Not disposed: the callback may still come after the wait gives up. Callbacks run on
                // dnsapi's threads and must never throw.
                var finished = new ManualResetEventSlim();
                InstanceCallback done = (status, context, removed) =>
                {
                    try { if (removed != IntPtr.Zero && removed != made) DnsServiceFreeInstance(removed); } catch (Exception) { }
                    finished.Set();
                };
                lock (keepAlive) keepAlive.Add(done);
                var value = Marshal.PtrToStructure<RegisterRequest>(request);
                value.Callback = Marshal.GetFunctionPointerForDelegate(done);
                Marshal.StructureToPtr(value, request, false);
                // Freed only once dnsapi says it is done; otherwise a few bytes stay allocated.
                if (DnsServiceDeRegister(request, IntPtr.Zero) == DnsRequestPending && finished.Wait(3000))
                {
                    DnsServiceFreeInstance(made);
                    Marshal.FreeHGlobal(request);
                }
            }
            catch (Exception e) when (e is DllNotFoundException || e is EntryPointNotFoundException) { }
        }

        /// Browses for 60% of the timeout, then resolves what it found. The few hundred bytes of query
        /// memory per search are never freed: dnsapi may still read them after a cancel.
        public IList<LanFound> Browse(TimeSpan timeout)
        {
            var names = new List<string>();
            BrowseCallback found = (status, context, records) =>
            {
                try
                {
                    // DNS_RECORD: pNext, pName, wType, wDataLength, Flags, dwTtl, dwReserved, then Data (PTR: pNameHost).
                    for (var r = records; r != IntPtr.Zero; r = Marshal.ReadIntPtr(r))
                    {
                        if (Marshal.ReadInt16(r, 2 * IntPtr.Size) != DnsTypePtr) continue;
                        var target = Marshal.PtrToStringUni(Marshal.ReadIntPtr(r, 2 * IntPtr.Size + 16));
                        if (target == null || !target.EndsWith("." + Domain, StringComparison.OrdinalIgnoreCase)) continue;
                        lock (names) if (names.Count < 64 && !names.Contains(target)) names.Add(target);
                    }
                }
                catch (Exception) { }
                finally { try { if (records != IntPtr.Zero) DnsFree(records, DnsFreeRecordList); } catch (Exception) { } }
            };
            lock (keepAlive) keepAlive.Add(found);
            var query = Marshal.StringToHGlobalUni(Domain);
            var cancel = Zeroed(IntPtr.Size);
            var request = Struct(new QueryRequest { Version = QueryRequestVersion1, QueryName = query, Callback = Marshal.GetFunctionPointerForDelegate(found) });
            var status = DnsServiceBrowse(request, cancel);
            if (status != DnsRequestPending) throw new InvalidOperationException("DnsServiceBrowse failed: " + status);
            Thread.Sleep(TimeSpan.FromMilliseconds(timeout.TotalMilliseconds * 0.6));
            DnsServiceBrowseCancel(cancel);
            List<string> instances;
            lock (names) instances = new List<string>(names);
            var sessions = new List<LanFound>();
            var waits = new List<Tuple<ManualResetEventSlim, IntPtr>>();
            foreach (var full in instances)
            {
                var label = full.Substring(0, full.Length - Domain.Length - 1);
                var resolved = new ManualResetEventSlim();
                InstanceCallback done = (s, c, result) =>
                {
                    try
                    {
                        if (result == IntPtr.Zero) return;
                        var info = Marshal.PtrToStructure<ServiceInstance>(result);
                        var addresses = new List<string>();
                        if (info.Ip4Address != IntPtr.Zero)
                        {
                            var b = new byte[4];
                            Marshal.Copy(info.Ip4Address, b, 0, 4);
                            addresses.Add(new IPAddress(b).ToString());
                        }
                        if (info.Ip6Address != IntPtr.Zero)
                        {
                            var b = new byte[16];
                            Marshal.Copy(info.Ip6Address, b, 0, 16);
                            addresses.Add(new IPAddress(b).ToString());
                        }
                        lock (sessions) foreach (var a in addresses) sessions.Add(new LanFound { Name = label.Replace('․', '.'), Address = a, Port = info.Port });
                        DnsServiceFreeInstance(result);
                    }
                    catch (Exception) { }
                    finally { resolved.Set(); }
                };
                lock (keepAlive) keepAlive.Add(done);
                var resolveCancel = Zeroed(IntPtr.Size);
                var resolveRequest = Struct(new QueryRequest { Version = QueryRequestVersion1, QueryName = Marshal.StringToHGlobalUni(full), Callback = Marshal.GetFunctionPointerForDelegate(done) });
                if (DnsServiceResolve(resolveRequest, resolveCancel) == DnsRequestPending) waits.Add(Tuple.Create(resolved, resolveCancel));
            }
            var deadline = DateTime.UtcNow + TimeSpan.FromMilliseconds(timeout.TotalMilliseconds * 0.4);
            foreach (var w in waits)
            {
                var left = deadline - DateTime.UtcNow;
                if (left < TimeSpan.Zero || !w.Item1.Wait(left)) DnsServiceResolveCancel(w.Item2);
            }
            lock (sessions) return new List<LanFound>(sessions);
        }
    }
}
