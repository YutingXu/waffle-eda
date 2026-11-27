// Same-network live sessions for the macOS app (docs/collaboration.md, Other ways to connect).
//
// While a host shares a session as "Visible on this network", LanRelay runs the Waffle relay protocol
// (version 2, lan mode, as collab/relay/waffle_relay.py with `lan`: one room, an info message with the
// session's public facts, the relay's limits) over WebSocket on Wi-Fi, Ethernet and loopback only (never
// cellular or VPN interfaces), and advertises it with Bonjour as _waffle._tcp under the session's display
// name only. Nothing listens before start or after stop. Joining still needs the session's key (the short
// code the host reads out, or the link): the relay sees only ciphertext. Self-contained: main.swift
// registers the bridge actions (lanStart, lanHost, lanStop, lanBrowse); native/tests/lan_relay.py runs the
// same conformance suite against this listener, the Linux one and the Windows one, on loopback.
import CryptoKit
import Foundation
import Network

final class LanRelay {
    static let service = "_waffle._tcp", defaultPort: UInt16 = 48765

    /// The relay's limits (waffle_relay.py, class Limits), under its names. Tests may change them before start.
    enum Limits {
        static var frame = 1 << 20, signal = 64 * 1024, peers = 16, perAddress = 32, joins = 60, roomJoins = 20
        static var joinTimeout = 10.0, idle = 600.0, rateWindow = 10.0, stall = 5.0, sweep = 60.0
        /// A quiet room is never closed: the listener ends with the host's session (waffle_relay.py lan_room_idle; 0: off).
        static var lanRoomIdle = 0.0
        static var rateMessages = 400, rateBytes = 24 << 20, queue = 6 << 20, queueSoft = 3 << 20
        /// One limit by its waffle_relay.py name (the conformance driver's WAFFLE_LAN_LIMITS); false if unknown.
        static func set(_ name: String, _ value: Double) -> Bool {
            switch name {
            case "frame": frame = Int(value)
            case "signal": signal = Int(value)
            case "peers": peers = Int(value)
            case "per_address": perAddress = Int(value)
            case "joins": joins = Int(value)
            case "room_joins": roomJoins = Int(value)
            case "join_timeout": joinTimeout = value
            case "idle": idle = value
            case "rate_window": rateWindow = value
            case "rate_messages": rateMessages = Int(value)
            case "rate_bytes": rateBytes = Int(value)
            case "queue": queue = Int(value)
            case "queue_soft": queueSoft = Int(value)
            case "stall": stall = value
            case "lan_room_idle": lanRoomIdle = value
            case "room_idle": break   // the public relay's rule for abandoned rooms; never on the local network
            case "sweep": sweep = value
            default: return false
            }
            return true
        }
    }

    private final class Peer {
        let conn: NWConnection, address: String
        var id: String?
        var owner = false, asked = false, closing = false
        var queued = 0
        var heard = Date()                                   // the last text message (join and idle timeouts)
        var watcher: DispatchWorkItem?
        var windowStart = Date(), windowCount = 0, windowBytes = 0
        init(_ conn: NWConnection, _ address: String) { self.conn = conn; self.address = address }
    }

    private let queue = DispatchQueue(label: "atrium.lan-relay")
    private var listener: NWListener?
    private var sweeper: DispatchSourceTimer?
    private var peers: [ObjectIdentifier: Peer] = [:]
    private var byAddress: [String: Int] = [:]
    private var joinLog: [String: [Date]] = [:], roomJoinLog: [String: [Date]] = [:]
    private var room = "", salt = "", name = "", host: String?
    private var ownerHash: String?
    private var active = Date()

    var running: Bool { queue.sync { listener != nil } }

    /// Starts listening (the default port, else any free one) and, with `advertise`, Bonjour. loopbackOnly:
    /// tests listen on 127.0.0.1 alone. completion: lanStart's reply ["port", "addresses", "primary",
    /// "advertised", "name"] (as on Linux and Windows) or an error.
    func start(room: String, salt: String, name: String, advertise: Bool = true, loopbackOnly: Bool = false,
               completion: @escaping (Result<[String: Any], Error>) -> Void) {
        _ = stop()
        guard room.range(of: "^[0-9a-f]{64}$", options: .regularExpression) != nil else { completion(.failure(LanError("Not a session id."))); return }
        guard (16...64).contains(salt.count) else { completion(.failure(LanError("Not a session salt."))); return }
        let display = String(name.split(whereSeparator: \.isWhitespace).joined(separator: " ").prefix(63))
        let serviceName = display.isEmpty ? "Waffle session" : display
        let addresses = loopbackOnly ? [] : Self.addresses()
        guard loopbackOnly || !addresses.isEmpty else {
            completion(.failure(LanError("This computer is not on a local network (no Wi-Fi or Ethernet address)."))); return
        }
        let primary = Self.primary(among: addresses)
        let ordered = primary.map { p in [p] + addresses.filter { $0 != p } } ?? addresses
        // Everything about the listener happens on `queue`: the first attempt and the free-port fallback
        // (which runs from the listener's own state handler, already on `queue`). The completion runs there too.
        queue.async {
            self.room = room; self.salt = salt; self.name = serviceName; self.host = nil; self.ownerHash = nil
            self.joinLog = [:]; self.roomJoinLog = [:]
            let reply: [String: Any] = ["addresses": ordered, "primary": primary ?? NSNull(), "advertised": advertise, "name": serviceName]
            self.listen(port: Self.defaultPort, reply: reply, advertise: advertise, loopbackOnly: loopbackOnly, fallback: true, completion: completion)
        }
    }

    /// On `queue` only: never `queue.sync` from here (the fallback runs inside the listener's handler on `queue`).
    private func listen(port: UInt16, reply: [String: Any], advertise: Bool, loopbackOnly: Bool, fallback: Bool,
                        completion: @escaping (Result<[String: Any], Error>) -> Void) {
        dispatchPrecondition(condition: .onQueue(queue))
        let failed: (Error) -> Void = { error in
            if fallback { self.listen(port: 0, reply: reply, advertise: advertise, loopbackOnly: loopbackOnly, fallback: false, completion: completion) }
            else { completion(.failure(LanError("Could not listen on the local network: \(error.localizedDescription)"))) }
        }
        let ws = NWProtocolWebSocket.Options()
        ws.autoReplyPing = true
        ws.maximumMessageSize = Limits.frame
        let params = NWParameters.tcp
        params.defaultProtocolStack.applicationProtocols.insert(ws, at: 0)
        params.prohibitedInterfaceTypes = [.cellular, .other]   // Wi-Fi, Ethernet and loopback only
        params.includePeerToPeer = false
        let nwPort = port == 0 ? NWEndpoint.Port.any : NWEndpoint.Port(rawValue: port)!
        if loopbackOnly { params.requiredLocalEndpoint = .hostPort(host: "127.0.0.1", port: nwPort) }
        let listener: NWListener
        do { listener = loopbackOnly ? try NWListener(using: params) : try NWListener(using: params, on: nwPort) } catch { failed(error); return }
        if advertise {
            let txt = NetService.data(fromTXTRecord: ["v": Data("2".utf8)])
            listener.service = NWListener.Service(name: reply["name"] as? String, type: Self.service, domain: nil, txtRecord: txt)
        }
        var finished = false
        listener.stateUpdateHandler = { [weak self] state in
            guard let self, !finished else { return }
            switch state {
            case .ready:
                finished = true
                var out = reply
                out["port"] = Int(listener.port?.rawValue ?? 0)
                self.sweep()
                completion(.success(out))
            case .failed(let error):
                finished = true
                listener.cancel()
                if self.listener === listener { self.listener = nil }
                failed(error)
            default: break
            }
        }
        listener.newConnectionHandler = { [weak self] conn in self?.accept(conn) }
        self.listener = listener
        listener.start(queue: queue)
    }

    /// lanHost: the host's peer id, given to guests in info. Its reply.
    func setHost(_ id: String?) -> [String: Any] {
        queue.sync {
            if let id, id.count <= 80, listener != nil { host = id }
            return ["ok": listener != nil]
        }
    }

    /// lanStop: the listener and every connection end. Its reply.
    @discardableResult
    func stop() -> [String: Any] {
        queue.sync {
            listener?.cancel(); listener = nil
            sweeper?.cancel(); sweeper = nil
            for p in Array(peers.values) { close(p, 1001) }
            peers.removeAll(); byAddress.removeAll()
        }
        return ["stopped": true]
    }

    // ---- connections ----
    /// The address a connection counts against: an IPv6 /64 is one address, as on the relay.
    private static func address(of endpoint: NWEndpoint) -> String {
        guard case .hostPort(let host, _) = endpoint else { return "local" }
        switch host {
        case .ipv4(let a): return a.rawValue.map(String.init).joined(separator: ".")
        case .ipv6(let a):
            let raw = [UInt8](a.rawValue)
            if raw.count == 16, raw[0..<10].allSatisfy({ $0 == 0 }), raw[10] == 0xff, raw[11] == 0xff { return raw[12...].map(String.init).joined(separator: ".") }
            return raw.prefix(8).map { String(format: "%02x", $0) }.joined() + "/64"
        default: return "\(host)"
        }
    }

    private func accept(_ conn: NWConnection) {
        let address = Self.address(of: conn.endpoint)
        // At most four connections per place in the room, and the relay's limit per address.
        guard listener != nil, peers.count < 4 * Limits.peers, byAddress[address, default: 0] < Limits.perAddress else { conn.cancel(); return }
        let p = Peer(conn, address)
        peers[ObjectIdentifier(p)] = p
        byAddress[address, default: 0] += 1
        conn.stateUpdateHandler = { [weak self] state in
            switch state {
            case .failed, .cancelled: self?.drop(p)
            default: break
            }
        }
        conn.start(queue: queue)
        receive(p)
        watch(p)
    }

    /// The join timeout before the join (renewed by info), the idle timeout after it.
    private func watch(_ p: Peer) {
        p.watcher?.cancel()
        guard !p.closing, peers[ObjectIdentifier(p)] != nil else { return }
        let left = p.heard.addingTimeInterval(p.id == nil ? Limits.joinTimeout : Limits.idle).timeIntervalSinceNow
        if left <= 0 { close(p, p.id == nil ? 1008 : 1001); return }
        let item = DispatchWorkItem { [weak self] in self?.watch(p) }
        p.watcher = item
        queue.asyncAfter(deadline: .now() + left, execute: item)
    }

    /// With Limits.lanRoomIdle set, a room with no forwarded message for that long is closed (off by default).
    private func sweep() {
        sweeper?.cancel(); sweeper = nil
        guard Limits.lanRoomIdle > 0 else { return }
        let timer = DispatchSource.makeTimerSource(queue: queue)
        timer.schedule(deadline: .now() + Limits.sweep, repeating: Limits.sweep)
        timer.setEventHandler { [weak self] in
            guard let self else { return }
            let members = self.joined()
            if !members.isEmpty, Date().timeIntervalSince(self.active) > Limits.lanRoomIdle { for p in members { self.close(p, 1001) } }
        }
        sweeper = timer
        timer.resume()
    }

    private func receive(_ p: Peer) {
        p.conn.receiveMessage { [weak self] data, context, _, error in
            guard let self, !p.closing, self.peers[ObjectIdentifier(p)] != nil else { return }
            guard error == nil, let meta = context?.protocolMetadata(definition: NWProtocolWebSocket.definition) as? NWProtocolWebSocket.Metadata else {
                if error != nil || data == nil { self.drop(p) } else { self.receive(p) }
                return
            }
            switch meta.opcode {
            case .close: self.drop(p)
            case .binary: self.close(p, 1003)
            case .text:
                let body = data ?? Data()
                p.heard = Date()
                let wait = p.id == nil ? 0 : self.throttle(p, body.count)
                let go = { [weak self] in
                    guard let self, !p.closing, self.peers[ObjectIdentifier(p)] != nil else { return }
                    self.handle(p, body) { [weak self] in
                        guard let self, !p.closing, self.peers[ObjectIdentifier(p)] != nil else { return }
                        self.receive(p)
                    }
                }
                if wait > 0 { self.queue.asyncAfter(deadline: .now() + wait, execute: go) } else { go() }
            default: self.receive(p)   // ping (answered by the framework), pong
            }
        }
    }

    /// Per-connection rate: past the budget the sender waits (is not read) until the next window.
    private func throttle(_ p: Peer, _ size: Int) -> Double {
        let now = Date()
        if now.timeIntervalSince(p.windowStart) > Limits.rateWindow { p.windowStart = now; p.windowCount = 0; p.windowBytes = 0 }
        p.windowCount += 1
        p.windowBytes += size
        guard p.windowCount > Limits.rateMessages || p.windowBytes > Limits.rateBytes else { return 0 }
        let wait = max(0, p.windowStart.addingTimeInterval(Limits.rateWindow).timeIntervalSince(now))
        p.windowStart = now.addingTimeInterval(wait); p.windowCount = 1; p.windowBytes = size
        return wait
    }

    /// Leaves the room (announced to the others) and forgets the connection.
    private func drop(_ p: Peer) {
        leave(p)
        p.conn.cancel()
        p.watcher?.cancel(); p.watcher = nil
        guard peers.removeValue(forKey: ObjectIdentifier(p)) != nil else { return }
        if let n = byAddress[p.address] { if n <= 1 { byAddress.removeValue(forKey: p.address) } else { byAddress[p.address] = n - 1 } }
    }

    private func leave(_ p: Peer) {
        guard let id = p.id else { return }
        p.id = nil
        let others = joined().filter { $0 !== p }
        for o in others { send(o, ["t": "peer", "id": id, "joined": false]); send(o, ["t": "peers", "n": others.count - 1]) }
    }

    /// Sends a close frame with this code (where the framework can say it) after what is queued, and ends.
    private func close(_ p: Peer, _ code: UInt16) {
        guard !p.closing else { return }
        p.closing = true
        leave(p)
        let defined: [UInt16: NWProtocolWebSocket.CloseCode.Defined] = [1000: .normalClosure, 1001: .goingAway, 1002: .protocolError,
                                                                       1003: .unsupportedData, 1008: .policyViolation, 1009: .messageTooBig]
        let meta = NWProtocolWebSocket.Metadata(opcode: .close)
        if let known = defined[code] { meta.closeCode = .protocolCode(known) }   // 1013 (try again later) has no name here: no status
        let context = NWConnection.ContentContext(identifier: "close", metadata: [meta])
        p.conn.send(content: nil, contentContext: context, isComplete: true, completion: .contentProcessed { [weak self] _ in self?.drop(p) })
        queue.asyncAfter(deadline: .now() + 2) { [weak self] in self?.drop(p) }   // a peer that stopped reading
    }

    private func joined() -> [Peer] { peers.values.filter { $0.id != nil && !$0.closing } }

    private func send(_ p: Peer, _ obj: [String: Any]) {
        guard let data = try? JSONSerialization.data(withJSONObject: obj) else { return }
        sendRaw(p, data)
    }

    /// Each peer has its own queue (bytes not yet taken by the network); past Limits.queue it is cut off.
    private func sendRaw(_ p: Peer, _ data: Data) {
        guard !p.closing else { return }
        if p.queued + data.count > Limits.queue { close(p, 1013); return }
        p.queued += data.count
        let meta = NWProtocolWebSocket.Metadata(opcode: .text)
        let context = NWConnection.ContentContext(identifier: "m", metadata: [meta])
        p.conn.send(content: data, contentContext: context, isComplete: true, completion: .contentProcessed { _ in p.queued -= data.count })
    }

    private func refuse(_ p: Peer, _ why: String) {
        send(p, ["t": "error", "e": why])
        close(p, 1008)
    }

    private static func sha256(_ data: Data) -> String { SHA256.hash(data: data).map { String(format: "%02x", $0) }.joined() }
    private static func bytes(hex: String) -> Data? {
        guard hex.count % 2 == 0 else { return nil }
        var out = Data(capacity: hex.count / 2), i = hex.startIndex
        while i < hex.endIndex { let j = hex.index(i, offsetBy: 2); guard let b = UInt8(hex[i..<j], radix: 16) else { return nil }; out.append(b); i = j }
        return out
    }

    /// A rate window per address (joins per minute, joins into the room per 10 minutes): false when full.
    private static func admit(_ log: inout [String: [Date]], _ address: String, _ limit: Int, _ seconds: Double) -> Bool {
        let now = Date()
        var times = (log[address] ?? []).filter { now.timeIntervalSince($0) <= seconds }
        defer { log[address] = times.isEmpty ? nil : times }
        guard times.count < limit else { return false }
        times.append(now)
        return true
    }

    /// One text message; next() reads the following one (later, while a recipient is behind).
    private func handle(_ p: Peer, _ data: Data, next: @escaping () -> Void) {
        guard let id = p.id else { join(p, data, next: next); return }
        guard let m = (try? JSONSerialization.jsonObject(with: data)) as? [String: Any], let t = m["t"] as? String else { next(); return }
        switch t {
        case "m":
            guard let d = m["d"] as? String, let out = try? JSONSerialization.data(withJSONObject: ["t": "m", "d": d, "from": id]) else { next(); return }
            let others = joined().filter { $0 !== p }
            let targets: [Peer]
            if let to = m["to"] as? [Any] {
                let wanted = Set(to.prefix(64).compactMap { $0 as? String })
                targets = others.filter { wanted.contains($0.id ?? "") }
            } else { targets = others }
            active = Date()
            for o in targets { sendRaw(o, out) }
            settle(p, targets, until: Date().addingTimeInterval(Limits.stall), then: next)
        case "sig":
            if let d = m["d"] as? String, d.unicodeScalars.count <= Limits.signal, let to = m["to"] as? String,
               let o = joined().first(where: { $0.id == to && $0 !== p }) {
                active = Date()
                send(o, ["t": "sig", "from": id, "d": d])
            }
            next()
        case "p":
            send(p, ["t": "p"])   // the keepalive's answer, to the sender only: the client finds a stalled connection by it
            next()
        default: next()   // attestations and TURN requests: nothing to do here
        }
    }

    /// Stop reading a sender while a recipient is more than Limits.queueSoft behind; a recipient that
    /// stays behind until the deadline is cut off, so it cannot hold the room back for long.
    private func settle(_ sender: Peer, _ targets: [Peer], until deadline: Date, then next: @escaping () -> Void) {
        let behind = targets.filter { !$0.closing && $0.queued > Limits.queueSoft }
        if behind.isEmpty || sender.closing { next(); return }
        if Date() >= deadline { for o in behind { close(o, 1013) }; next(); return }
        queue.asyncAfter(deadline: .now() + 0.02) { [weak self] in self?.settle(sender, behind, until: deadline, then: next) }
    }

    /// The first message: info (once), then a join with the room's token.
    private func join(_ p: Peer, _ data: Data, next: @escaping () -> Void) {
        guard let parsed = try? JSONSerialization.jsonObject(with: data, options: [.fragmentsAllowed]) else { close(p, 1008); return }
        let m = parsed as? [String: Any] ?? [:]
        if m["t"] as? String == "info", !p.asked {
            p.asked = true
            send(p, ["t": "info", "v": 2, "salt": salt, "name": name, "host": host ?? NSNull()])
            next()
            return
        }
        guard m["t"] as? String == "join", let r = m["room"] as? String, let auth = m["auth"] as? String,
              r.range(of: "^[0-9a-f]{64}$", options: .regularExpression) != nil, auth.count == 64,
              let raw = Self.bytes(hex: auth), Self.sha256(raw) == r else { refuse(p, "The room key does not match this room."); return }
        guard r == room else { refuse(p, "This Waffle session is not shared here any more."); return }
        guard Self.admit(&joinLog, p.address, Limits.joins, 60) else { refuse(p, "Too many joins from this address; try again in a minute."); return }
        var own: String?
        if let token = m["own"] as? String, (16...128).contains(token.count) { own = Self.sha256(Data(token.utf8)) }
        let others = joined()
        // The owner is the first joiner with an owner token for as long as the session is shared.
        if others.isEmpty && ownerHash == nil { ownerHash = own }
        let owner = own != nil && own == ownerHash
        if !others.isEmpty && !owner && !Self.admit(&roomJoinLog, p.address, Limits.roomJoins, 600) {
            refuse(p, "Too many joins into this session from this address; try again in a few minutes."); return
        }
        guard others.count < Limits.peers + (owner ? 2 : 0) else {
            send(p, ["t": "error", "e": "This room is full."]); close(p, 1013); return
        }
        if others.isEmpty { active = Date() }
        let newId = "c" + (0..<8).map { _ in String(format: "%02x", UInt8.random(in: 0...255)) }.joined()
        p.id = newId; p.owner = owner
        send(p, ["t": "joined", "v": 2, "id": newId, "peers": others.compactMap { $0.id }, "ice": [Any](), "ttl": 3600, "owner": owner])
        for o in others { send(o, ["t": "peer", "id": newId, "joined": true]); send(o, ["t": "peers", "n": others.count]) }
        watch(p)   // the idle timeout from now on
        next()
    }

    // ---- addresses and browsing ----
    /// This computer's local-network addresses: private IPv4 (10/8, 172.16/12, 192.168/16) and unique-local
    /// IPv6 (fc00::/7) of its Wi-Fi and Ethernet interfaces (en*), never loopback, link-local, VPN (utun,
    /// ipsec), bridges (Internet Sharing, virtual machines) or AirDrop; IPv4 first.
    static func addresses() -> [String] {
        var v4: [String] = [], v6: [String] = []
        var list: UnsafeMutablePointer<ifaddrs>?
        guard getifaddrs(&list) == 0, let first = list else { return [] }
        defer { freeifaddrs(list) }
        for item in sequence(first: first, next: { $0.pointee.ifa_next }) {
            let flags = Int32(item.pointee.ifa_flags)
            guard flags & IFF_UP != 0, flags & IFF_LOOPBACK == 0, flags & IFF_POINTOPOINT == 0, let sa = item.pointee.ifa_addr else { continue }
            guard String(cString: item.pointee.ifa_name).hasPrefix("en") else { continue }
            let family = Int32(sa.pointee.sa_family)
            guard family == AF_INET || family == AF_INET6 else { continue }
            var host = [CChar](repeating: 0, count: Int(NI_MAXHOST))
            guard getnameinfo(sa, socklen_t(sa.pointee.sa_len), &host, socklen_t(host.count), nil, 0, NI_NUMERICHOST) == 0 else { continue }
            let ip = String(cString: host)
            if family == AF_INET {
                let parts = ip.split(separator: ".").compactMap { Int($0) }
                guard parts.count == 4, parts[0] == 10 || (parts[0] == 172 && (16...31).contains(parts[1])) || (parts[0] == 192 && parts[1] == 168) else { continue }
                if !v4.contains(ip) { v4.append(ip) }
            } else {
                let lower = ip.lowercased()
                guard lower.hasPrefix("fc") || lower.hasPrefix("fd"), !lower.contains("%") else { continue }
                if !v6.contains(lower) { v6.append(lower) }
            }
        }
        return v4 + v6
    }

    /// The address the default route leaves from, when it is one of `addresses` (the invitation names
    /// it); nil behind a VPN or with no route. A UDP connect sends nothing.
    static func primary(among addresses: [String]) -> String? {
        let fd = socket(AF_INET, SOCK_DGRAM, 0)
        guard fd >= 0, !addresses.isEmpty else { if fd >= 0 { Darwin.close(fd) }; return nil }
        defer { Darwin.close(fd) }
        var to = sockaddr_in()
        to.sin_len = UInt8(MemoryLayout<sockaddr_in>.size); to.sin_family = sa_family_t(AF_INET); to.sin_port = UInt16(9).bigEndian
        inet_pton(AF_INET, "192.0.2.1", &to.sin_addr)
        let size = socklen_t(MemoryLayout<sockaddr_in>.size)
        guard withUnsafePointer(to: &to, { $0.withMemoryRebound(to: sockaddr.self, capacity: 1) { connect(fd, $0, size) } }) == 0 else { return nil }
        var me = sockaddr_in(), length = size
        guard withUnsafeMutablePointer(to: &me, { $0.withMemoryRebound(to: sockaddr.self, capacity: 1) { getsockname(fd, $0, &length) } }) == 0 else { return nil }
        var text = [CChar](repeating: 0, count: Int(INET_ADDRSTRLEN))
        inet_ntop(AF_INET, &me.sin_addr, &text, socklen_t(text.count))
        let ip = String(cString: text)
        return addresses.contains(ip) ? ip : nil
    }

    /// Sessions advertised on the local network, as lanBrowse's "sessions" on every host: [["name",
    /// "address", "port"]] by name, IPv4 before IPv6, no link-local addresses, after `seconds`.
    static func browse(seconds: Double = 2.5, completion: @escaping ([[String: Any]]) -> Void) {
        let finder = Finder(seconds: seconds, completion: completion)
        finder.begin()
    }

    private final class Finder: NSObject, NetServiceBrowserDelegate, NetServiceDelegate {
        private let browser = NetServiceBrowser(), seconds: Double, completion: ([[String: Any]]) -> Void
        private var services: [NetService] = [], found: [[String: Any]] = []
        private var keep: Finder?
        init(seconds: Double, completion: @escaping ([[String: Any]]) -> Void) { self.seconds = seconds; self.completion = completion }
        func begin() {
            keep = self
            browser.delegate = self
            browser.schedule(in: .main, forMode: .common)
            browser.searchForServices(ofType: LanRelay.service + ".", inDomain: "local.")
            DispatchQueue.main.asyncAfter(deadline: .now() + seconds) { self.finish() }
        }
        func netServiceBrowser(_ browser: NetServiceBrowser, didFind service: NetService, moreComing: Bool) {
            services.append(service)
            service.delegate = self
            service.resolve(withTimeout: max(0.5, seconds - 0.5))
        }
        func netServiceDidResolveAddress(_ sender: NetService) {
            for data in sender.addresses ?? [] {
                let ip: String? = data.withUnsafeBytes { raw in
                    guard let sa = raw.baseAddress?.assumingMemoryBound(to: sockaddr.self) else { return nil }
                    let family = Int32(sa.pointee.sa_family)
                    guard family == AF_INET || family == AF_INET6 else { return nil }
                    var host = [CChar](repeating: 0, count: Int(NI_MAXHOST))
                    guard getnameinfo(sa, socklen_t(data.count), &host, socklen_t(host.count), nil, 0, NI_NUMERICHOST) == 0 else { return nil }
                    let text = String(cString: host).lowercased()
                    return family == AF_INET6 && (text.hasPrefix("fe80") || text.contains("%")) ? nil : text
                }
                if let ip, !found.contains(where: { ($0["address"] as? String) == ip && ($0["port"] as? Int) == sender.port }) {
                    found.append(["name": String(sender.name.prefix(64)), "address": ip, "port": sender.port])
                }
            }
        }
        private func finish() {
            browser.stop()
            for s in services { s.stop() }
            let key = { (s: [String: Any]) in ((s["name"] as? String ?? "").lowercased(), (s["address"] as? String ?? "").contains(":") ? 1 : 0) }
            completion(found.sorted { key($0) < key($1) })
            keep = nil
        }
    }
}

struct LanError: LocalizedError {
    let message: String
    init(_ message: String) { self.message = message }
    var errorDescription: String? { message }
}
