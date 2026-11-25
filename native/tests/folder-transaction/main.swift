import Foundation
import Darwin

// Synthetic process-death/fault driver. Product dispatch never installs this hook.
let env = ProcessInfo.processInfo.environment
func checkpoint(_ name: String, _ path: String?) throws {
    FileHandle.standardError.write(Data((name + (path.map { " " + $0 } ?? "") + "\n").utf8))
    if env["WAFFLE_FOLDER_KILL"] == name { kill(getpid(),SIGKILL); _exit(137) }
    if env["WAFFLE_FOLDER_FAIL"] == name {
        throw NSError(domain:NSPOSIXErrorDomain,code:Int(env["WAFFLE_FOLDER_ERRNO"] ?? "") ?? Int(EIO))
    }
    if env["WAFFLE_FOLDER_PAUSE"] == name, let gate = env["WAFFLE_FOLDER_GATE"] {
        try Data().write(to:URL(fileURLWithPath:gate + ".ready"))
        let limit = DispatchTime.now().uptimeNanoseconds + 60_000_000_000
        while !FileManager.default.fileExists(atPath:gate + ".resume") {
            guard DispatchTime.now().uptimeNanoseconds < limit else { throw FolderFailure("Test gate timed out.") }
            usleep(1000)
        }
    }
}
func output(_ o: [String:Any]) {
    guard let b = try? JSONSerialization.data(withJSONObject:o,options:[.sortedKeys,.withoutEscapingSlashes]) else { exit(2) }
    FileHandle.standardOutput.write(b + Data([10]))
}
func request() throws -> [String:Any] {
    guard let o = try JSONSerialization.jsonObject(with:FileHandle.standardInput.readDataToEndOfFile()) as? [String:Any] else {
        throw FolderFailure("Invalid input.")
    }
    return o
}
// Test-only injected syscall returns drive the exact production barrier routine.
func checkDeviceBarriers(_ path:String) throws -> [String:Any] {
    let directory = open(path,O_RDONLY|O_DIRECTORY|O_NOFOLLOW)
    guard directory >= 0 else { throw FolderFailure("Open the barrier test directory.") }
    defer { Darwin.close(directory) }
    let witness = openat(directory,"volume-witness",O_CREAT|O_EXCL|O_RDWR|O_NOFOLLOW,0o600)
    guard witness >= 0 else { throw FolderFailure("Create the private barrier test witness.") }
    defer { Darwin.close(witness); _ = unlinkat(directory,"volume-witness",0) }
    var cases:[String] = []
    func check(_ name:String, target:Int32, isDirectory:Bool, witnessArg:Int32?, failures:[Int32],
               namespaceFault:Int32 = 0, expected:[String], state:String? = nil) throws {
        var observed:[String]=[], attempt=0, errorState:String?
        do {
            try folderDeviceBarrier(target,directory:isDirectory,witness:witnessArg,full:{ source in
                observed.append(source == directory ? "full-dir" : "full-file")
                let code = failures.indices.contains(attempt) ? failures[attempt] : 0
                attempt += 1
                if code == 0 { return 0 }; errno = code; return -1
            },namespace:{ source in
                observed.append(source == directory ? "sync-dir" : "wrong")
                if namespaceFault == 0 { return 0 }; errno = namespaceFault; return -1
            })
        } catch let f as FolderFailure { errorState = f.state }
        guard observed == expected, errorState == state else { throw FolderFailure("Incorrect \(name) barrier result: \(observed), \(String(describing:errorState))") }
        cases.append(name)
    }
    try check("native-directory",target:directory,isDirectory:true,witnessArg:witness,failures:[],expected:["full-dir"])
    try check("interrupted-full",target:witness,isDirectory:false,witnessArg:nil,failures:[EINTR],expected:["full-file","full-file"])
    try check("regular-unsupported",target:witness,isDirectory:false,witnessArg:nil,failures:[ENOTSUP],expected:["full-file"],state:"unsupportedVolume")
    try check("directory-without-witness",target:directory,isDirectory:true,witnessArg:nil,failures:[EINVAL],expected:["full-dir"],state:"unsupportedVolume")
    try check("wrong-witness-type",target:directory,isDirectory:true,witnessArg:directory,failures:[ENOTTY],expected:["full-dir"],state:"unsupportedVolume")
    try check("witness",target:directory,isDirectory:true,witnessArg:witness,failures:[EINVAL,0],expected:["full-dir","sync-dir","full-file"])
    try check("unsupported-witness",target:directory,isDirectory:true,witnessArg:witness,failures:[ENOTSUP,ENOSYS],expected:["full-dir","sync-dir","full-file"],state:"unsupportedVolume")
    try check("unsupported-namespace",target:directory,isDirectory:true,witnessArg:witness,failures:[EINVAL],namespaceFault:EOPNOTSUPP,expected:["full-dir","sync-dir"],state:"unsupportedVolume")
    try check("directory-device-error",target:directory,isDirectory:true,witnessArg:witness,failures:[EIO],expected:["full-dir"],state:"recoveryPending")
    return ["cases":cases]
}
do {
    let args = CommandLine.arguments
    guard args.count == 4 else { throw FolderFailure("Expected root, manifest name and command.") }
    let store = try FolderTransactions(root:URL(fileURLWithPath:args[1]),manifest:args[2],checkpoint:checkpoint)
    switch args[3] {
    case "discover": output(["manifest":try FolderTransactions.selectedManifest(in:URL(fileURLWithPath:args[1]))])
    case "check-device-barriers": output(try checkDeviceBarriers(args[1]))
    case "model-session":
        output(["grant":store.grant])
        while let line = readLine() {
            do {
                guard let q = try JSONSerialization.jsonObject(with:Data(line.utf8)) as? [String:Any] else {
                    throw FolderFailure("Invalid model test request.")
                }
                switch q["op"] as? String {
                case "acquire": output(try store.desktopReadLease())
                case "verify": output(try store.readVerified(q))
                case "release": try store.release(q["lease"] as? String ?? ""); output(["released":true])
                default: throw FolderFailure("Unknown model test request.")
                }
            } catch { output(["error":error.localizedDescription]) }
        }
    case "commit": try store.commit(request(),acknowledged:output)
    case "commit-approved-copy":
        var q = try request()
        guard let verified = q.removeValue(forKey:"testNativeCopyHashes") as? [String:String] else { throw FolderFailure("Expected test-only selected-file evidence.") }
        try store.commit(q,nativeCopyHashes:verified,acknowledged:output)
    case "stage-save":
        var q = try request()
        guard let encoded = q["attachment"] as? String, let bytes = Data(base64Encoded:encoded),
              let owner = q["ownerId"] as? String, let media = q["mediaType"] as? String, var plan = q["plan"] as? [[String:Any]] else {
            throw FolderFailure("Expected a synthetic attachment and plan.")
        }
        let stage = try store.stageAsset(bytes:bytes,owner:owner,mediaType:media)
        guard let token = stage["assetToken"] as? String, let asset = stage["assetRef"] as? [String:Any] else { throw FolderFailure("Staging failed.") }
        let readable = try store.readAsset(lease:nil,stagedToken:token,owner:owner,asset:asset,purpose:"preview",offset:0,length:1<<20)
        guard readable["data"] as? String == bytes.prefix(1<<20).base64EncodedString() else { throw FolderFailure("Staged preview differs.") }
        for index in plan.indices where plan[index]["assetToken"] as? String == "test-token" { plan[index]["assetToken"] = token }
        q["plan"] = plan; try store.commit(q,acknowledged:output)
    case "asset-read":
        let q = try request(), lease = try store.acquire()
        defer { try? store.release(lease) }
        guard let a = q["assetRef"] as? [String:Any], let own = q["ownerId"] as? String,
              let offset = q["offset"] as? Int, let length = q["length"] as? Int else { throw FolderFailure("Expected asset and range.") }
        output(try store.readAsset(lease:lease,owner:own,asset:a,purpose:"preview",offset:offset,length:length))
    case "conflict": output(try store.conflict())
    case "resolve": try store.resolve(request(),acknowledged:output)
    case "recover": try store.recover(); output(store.status())
    case "status": output(store.status())
    case "read":
        let query = try request(), l = try store.acquire()
        defer { try? store.release(l) }
        try checkpoint("read-locked",nil)
        output(["files":try store.read(lease:l,paths:query["paths"] as? [String] ?? [])])
    default: throw FolderFailure("Unknown command.")
    }
} catch {
    let f = error as? FolderFailure ?? FolderFailure(error.localizedDescription)
    output(["error":f.localizedDescription,"state":f.state,"paths":f.paths]); exit(1)
}
