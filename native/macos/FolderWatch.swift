import Foundation
import CoreServices

/// A sleeping, recursive kernel event stream. An overflow asks the renderer to
/// recheck its manifest and observed members under a fresh saved snapshot lease.
final class FolderWatch {
    private var stream: FSEventStreamRef?
    private let root: String
    private let changed: ([String],Bool) -> Void
    init?(url: URL, queue: DispatchQueue, changed: @escaping ([String],Bool) -> Void) {
        root = url.path; self.changed = changed
        var ctx = FSEventStreamContext(version:0,info:Unmanaged.passUnretained(self).toOpaque(),retain:nil,release:nil,copyDescription:nil)
        let flags = UInt32(kFSEventStreamCreateFlagFileEvents | kFSEventStreamCreateFlagWatchRoot | kFSEventStreamCreateFlagUseCFTypes)
        guard let s = FSEventStreamCreate(nil,{ _, context, count, rawPaths, flags, _ in
            guard let context = context else { return }
            let watcher = Unmanaged<FolderWatch>.fromOpaque(context).takeUnretainedValue()
            let paths = unsafeBitCast(rawPaths,to:CFArray.self) as NSArray
            watcher.receive(paths:paths, flags:flags, count:count)
        },&ctx,[root] as CFArray,FSEventStreamEventId(kFSEventStreamEventIdSinceNow),0.10,flags) else { return nil }
        stream = s
        FSEventStreamSetDispatchQueue(s,queue)
        guard FSEventStreamStart(s) else { return nil }
    }
    private func receive(paths: NSArray, flags: UnsafePointer<FSEventStreamEventFlags>, count: Int) {
        let dropped = UInt32(kFSEventStreamEventFlagMustScanSubDirs | kFSEventStreamEventFlagUserDropped |
                             kFSEventStreamEventFlagKernelDropped | kFSEventStreamEventFlagRootChanged)
        var overflow = count > 512, relative = Set<String>()
        let privateStores = [".waffle/journal",".waffle/local",".waffle/previews",".waffle/cache",".waffle/history",".git"]
        for i in 0..<min(count,512) {
            if flags[i] & dropped != 0 { overflow = true }
            guard let full = paths[i] as? String, full.hasPrefix(root + "/") else { continue }
            let path = String(full.dropFirst(root.count+1)).precomposedStringWithCanonicalMapping
            if path == ".waffle" || privateStores.contains(where: { path == $0 || path.hasPrefix($0 + "/") }) { continue }
            if path == ".waffle/.gitignore" || path.hasPrefix(".waffle/imports/") || path.hasPrefix("assets/") ||
                path.hasPrefix("models/") || ["waffle","wsch","wpcb","wdraw","wpanel","wlib","wblock"].contains((path as NSString).pathExtension) {
                relative.insert(path)
            }
        }
        if overflow || !relative.isEmpty { changed(relative.sorted(),overflow) }
    }
    deinit {
        if let s = stream { FSEventStreamStop(s); FSEventStreamInvalidate(s); FSEventStreamRelease(s) }
    }
}
