// Same-network live sessions for the macOS app (docs/collaboration.md, Other ways to connect).
//
// While a host shares a session as "Visible on this network", LanRelay runs the Waffle relay protocol
// (version 2, lan mode, as collab/relay/waffle_relay.py with `lan`: one room, an info message with the
// session's public facts) over WebSocket on Wi-Fi, Ethernet and loopback only (never cellular or VPN
// interfaces), and advertises it with Bonjour as _waffle._tcp under the session's display name only.
// Nothing listens before start or after stop. Joining still needs the session's key (the short code the
// host reads out, or the link): the relay sees only ciphertext. Self-contained: main.swift registers the
// bridge actions (lanStart, lanHost, lanStop, lanBrowse); native/tests/lan_relay.py drives it on loopback.
import CryptoKit
import Foundation
import Network

final class LanRelay {
    static let service = "_waffle._tcp", defaultPort: UInt16 = 48765
    private static let maxPeers = 16, maxMessage = 1 << 20, maxQueued = 8 << 20, rateWindow = 10.0, rateBytes = 48 << 20

    private final class Peer {
        let conn: NWConnection
        var id: String?
        var owner = false
        var queued = 0
        var windowStart = Date(), windowBytes = 0
        init(_ conn: NWConnection) { self.conn = conn }
    }

    private let queue = DispatchQueue(label: "atrium.lan-relay")
    private var listener: NWListener?
    private var peers: [ObjectIdentifier: Peer] = [:]
    private var room = "", salt = "", name = "", host: String?
    private var ownerHash: String?

    var running: Bool { queue.sync { listener != nil } }

    /// Starts listening (the default port, else any free one) and, with `advertise`, Bonjour.
    /// completion: ["port", "addresses", "advertised", "name"] or an error message.
    func start(room: String, salt: String, name: String, advertise: Bool = true, completion: @escaping (Result<[String: Any], Error>) -> Void) {
        stop()
        let hex = room.range(of: "^[0-9a-f]{64}$", options: .regularExpression) != nil
        guard hex, (16...64).contains(salt.count) else { completion(.failure(LanError("Not a session."))); return }
        let display = String(name.split(whereSeparator: \.isWhitespace).joined(separator: " ").prefix(63))
        let serviceName = display.isEmpty ? "Waffle session" : display
        // Everything about the listener happens on `queue`: the first attempt and the free-port fallback
        // (which runs from the listener's own state handler, already on `queue`). The completion runs there too.
        queue.async {
            self.room = room; self.salt = salt; self.name = serviceName; self.host = nil; self.ownerHash = nil
            self.listen(port: Self.defaultPort, name: serviceName, advertise: advertise, fallback: true, completion: completion)
        }
    }

    /// On `queue` only: never `queue.sync` from here (the fallback runs inside the listener's handler on `queue`).
    private func listen(port: UInt16, name: String, advertise: Bool, fallback: Bool, completion: @escaping (Result<[String: Any], Error>) -> Void) {
        dispatchPrecondition(condition: .onQueue(queue))
        let ws = NWProtocolWebSocket.Options()
        ws.autoReplyPing = true
        ws.maximumMessageSize = Self.maxMessage
        let params = NWParameters.tcp
        params.defaultProtocolStack.applicationProtocols.insert(ws, at: 0)
        params.prohibitedInterfaceTypes = [.cellular, .other]   // Wi-Fi, Ethernet and loopback only
        params.includePeerToPeer = false
        let listener: NWListener
        do { listener = try NWListener(using: params, on: port == 0 ? .any : NWEndpoint.Port(rawValue: port)!) }
        catch { if fallback { listen(port: 0, name: name, advertise: advertise, fallback: false, completion: completion) } else { completion(.failure(error)) }; return }
        if advertise {
            let txt = NetService.data(fromTXTRecord: ["v": Data("2".utf8)])
            listener.service = NWListener.Service(name: name, type: Self.service, domain: nil, txtRecord: txt)
        }
        var finished = false
        listener.stateUpdateHandler = { [weak self] state in
            guard let self, !finished else { return }
            switch state {
            case .ready:
                finished = true
                let port = Int(listener.port?.rawValue ?? 0)
                completion(.success(["port": port, "addresses": Self.addresses(), "advertised": advertise, "name": name]))
            case .failed(let error):
                finished = true
                listener.cancel()
                if self.listener === listener { self.listener = nil }
                if fallback { self.listen(port: 0, name: name, advertise: advertise, fallback: false, completion: completion) } else { completion(.failure(error)) }
            default: break
            }
        }
        listener.newConnectionHandler = { [weak self] conn in self?.accept(conn) }
        self.listener = listener
        listener.start(queue: queue)
    }

    func setHost(_ id: String?) { queue.async { if let id, id.count <= 80 { self.host = id } } }

    func stop() {
        queue.sync {
            listener?.cancel(); listener = nil
            for p in peers.values { p.conn.cancel() }
            peers.removeAll()
        }
    }

    // ---- connections ----
    private func accept(_ conn: NWConnection) {
        guard peers.count < 4 * Self.maxPeers else { conn.cancel(); return }
        let p = Peer(conn)
        peers[ObjectIdentifier(p)] = p
        conn.stateUpdateHandler = { [weak self] state in
            switch state {
            case .failed, .cancelled: self?.drop(p)
            default: break
            }
        }
        conn.start(queue: queue)
        receive(p)
        // A join must come within 10 s.
        queue.asyncAfter(deadline: .now() + 10) { [weak self] in if p.id == nil { self?.drop(p) } }
    }

    private func receive(_ p: Peer) {
        p.conn.receiveMessage { [weak self] data, context, _, error in
            guard let self else { return }
            if error != nil { self.drop(p); return }
            if let data, let meta = context?.protocolMetadata(definition: NWProtocolWebSocket.definition) as? NWProtocolWebSocket.Metadata {
                if meta.opcode == .close { self.drop(p); return }
                if meta.opcode == .text { self.handle(p, data) } else if meta.opcode == .binary { self.drop(p); return }
            }
            if self.peers[ObjectIdentifier(p)] != nil { self.receive(p) }
        }
    }

    private func drop(_ p: Peer) {
        guard peers.removeValue(forKey: ObjectIdentifier(p)) != nil else { return }
        p.conn.cancel()
        guard let id = p.id else { return }
        let others = joined().filter { $0 !== p }
        for o in others { send(o, ["t": "peer", "id": id, "joined": false]); send(o, ["t": "peers", "n": others.count - 1]) }
    }

    private func joined() -> [Peer] { peers.values.filter { $0.id != nil } }

    private func send(_ p: Peer, _ obj: [String: Any]) {
        guard let data = try? JSONSerialization.data(withJSONObject: obj) else { return }
        sendRaw(p, data)
    }

    private func sendRaw(_ p: Peer, _ data: Data) {
        if p.queued + data.count > Self.maxQueued { drop(p); return }   // a peer that stopped reading
        p.queued += data.count
        let meta = NWProtocolWebSocket.Metadata(opcode: .text)
        let context = NWConnection.ContentContext(identifier: "m", metadata: [meta])
        p.conn.send(content: data, contentContext: context, isComplete: true, completion: .contentProcessed { [weak self] _ in
            self?.queue.async { p.queued -= data.count }
        })
    }

    private func refuse(_ p: Peer, _ why: String) {
        send(p, ["t": "error", "e": why])
        queue.asyncAfter(deadline: .now() + 0.5) { [weak self] in self?.drop(p) }
    }

    private static func sha256(_ data: Data) -> String { SHA256.hash(data: data).map { String(format: "%02x", $0) }.joined() }
    private static func bytes(hex: String) -> Data? {
        guard hex.count % 2 == 0 else { return nil }
        var out = Data(capacity: hex.count / 2), i = hex.startIndex
        while i < hex.endIndex { let j = hex.index(i, offsetBy: 2); guard let b = UInt8(hex[i..<j], radix: 16) else { return nil }; out.append(b); i = j }
        return out
    }

    private func handle(_ p: Peer, _ data: Data) {
        let now = Date()
        if now.timeIntervalSince(p.windowStart) > Self.rateWindow { p.windowStart = now; p.windowBytes = 0 }
        p.windowBytes += data.count
        if p.windowBytes > Self.rateBytes { drop(p); return }
        guard let m = (try? JSONSerialization.jsonObject(with: data)) as? [String: Any], let t = m["t"] as? String else { return }
        guard let id = p.id else {
            if t == "info" { send(p, ["t": "info", "v": 2, "salt": salt, "name": name, "host": host ?? NSNull()]); return }
            guard t == "join", let r = m["room"] as? String, let auth = m["auth"] as? String, let raw = Self.bytes(hex: auth), auth.count == 64,
                  Self.sha256(raw) == r else { refuse(p, "The room key does not match this room."); return }
            guard r == room else { refuse(p, "This Waffle session is not shared here any more."); return }
            var owner = false
            if let own = m["own"] as? String, (16...128).contains(own.count) {
                let h = Self.sha256(Data(own.utf8))
                if ownerHash == nil && joined().isEmpty { ownerHash = h }
                owner = h == ownerHash
            }
            let others = joined()
            guard others.count < Self.maxPeers + (owner ? 2 : 0) else { refuse(p, "This room is full."); return }
            let newId = "c" + (0..<8).map { _ in String(format: "%02x", UInt8.random(in: 0...255)) }.joined()
            p.id = newId; p.owner = owner
            send(p, ["t": "joined", "v": 2, "id": newId, "peers": others.compactMap { $0.id }, "ice": [Any](), "ttl": 3600, "owner": owner])
            for o in others { send(o, ["t": "peer", "id": newId, "joined": true]); send(o, ["t": "peers", "n": others.count]) }
            return
        }
        switch t {
        case "m":
            guard let d = m["d"] as? String else { return }
            guard let out = try? JSONSerialization.data(withJSONObject: ["t": "m", "d": d, "from": id]) else { return }
            let targets: [Peer]
            if let to = m["to"] as? [Any] {
                let wanted = Set(to.prefix(64).compactMap { $0 as? String })
                targets = joined().filter { $0 !== p && wanted.contains($0.id ?? "") }
            } else { targets = joined().filter { $0 !== p } }
            for o in targets { sendRaw(o, out) }
        case "sig":
            guard let d = m["d"] as? String, d.utf8.count <= 64 * 1024, let to = m["to"] as? String,
                  let o = joined().first(where: { $0.id == to && $0 !== p }) else { return }
            send(o, ["t": "sig", "from": id, "d": d])
        default: break   // keepalives ("p"), attestations and TURN requests: nothing to do here
        }
    }

    // ---- addresses and browsing ----
    /// This computer's local-network IPv4 addresses (private ranges, not loopback or link-local).
    static func addresses() -> [String] {
        var out: [String] = []
        var list: UnsafeMutablePointer<ifaddrs>?
        guard getifaddrs(&list) == 0, let first = list else { return out }
        defer { freeifaddrs(list) }
        for item in sequence(first: first, next: { $0.pointee.ifa_next }) {
            let flags = Int32(item.pointee.ifa_flags)
            guard flags & IFF_UP != 0, flags & IFF_LOOPBACK == 0, let sa = item.pointee.ifa_addr, sa.pointee.sa_family == UInt8(AF_INET) else { continue }
            let ifname = String(cString: item.pointee.ifa_name)
            guard ifname.hasPrefix("en") || ifname.hasPrefix("bridge") else { continue }   // Wi-Fi and Ethernet, not utun (VPN)
            var host = [CChar](repeating: 0, count: Int(NI_MAXHOST))
            guard getnameinfo(sa, socklen_t(sa.pointee.sa_len), &host, socklen_t(host.count), nil, 0, NI_NUMERICHOST) == 0 else { continue }
            let ip = String(cString: host), parts = ip.split(separator: ".").compactMap { Int($0) }
            guard parts.count == 4 else { continue }
            let privateRange = parts[0] == 10 || (parts[0] == 172 && (16...31).contains(parts[1])) || (parts[0] == 192 && parts[1] == 168)
            if privateRange && !out.contains(ip) { out.append(ip) }
        }
        return out
    }

    /// Sessions advertised on the local network: [["name", "address", "port"]], after `seconds`.
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
                    guard let sa = raw.baseAddress?.assumingMemoryBound(to: sockaddr.self), sa.pointee.sa_family == UInt8(AF_INET) else { return nil }
                    var host = [CChar](repeating: 0, count: Int(NI_MAXHOST))
                    return getnameinfo(sa, socklen_t(data.count), &host, socklen_t(host.count), nil, 0, NI_NUMERICHOST) == 0 ? String(cString: host) : nil
                }
                if let ip, !found.contains(where: { ($0["address"] as? String) == ip && ($0["port"] as? Int) == sender.port }) {
                    found.append(["name": String(sender.name.prefix(64)), "address": ip, "port": sender.port])
                }
            }
        }
        private func finish() {
            browser.stop()
            for s in services { s.stop() }
            completion(found.sorted { ($0["name"] as? String ?? "").lowercased() < ($1["name"] as? String ?? "").lowercased() })
            keep = nil
        }
    }
}

struct LanError: LocalizedError {
    let message: String
    init(_ message: String) { self.message = message }
    var errorDescription: String? { message }
}
