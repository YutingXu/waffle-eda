import CryptoKit
import Foundation

typealias Row = [String:Any]
let fm = FileManager.default
let root = fm.temporaryDirectory.appendingPathComponent("waffle-embedded-pdf-" + UUID().uuidString)
try fm.createDirectory(at:root,withIntermediateDirectories:false)
defer { try? fm.removeItem(at:root) }
let name = "Bench.waffle", project = "018cc251-f400-7001-8000-000000000001"
let pdf = try Data(contentsOf:URL(fileURLWithPath:CommandLine.arguments[1]))
func hash(_ bytes:Data) -> String {SHA256.hash(data:bytes).map{String(format:"%02x",$0)}.joined()}
func line(_ row:Row) throws -> String {
    let data = try JSONSerialization.data(withJSONObject:row,options:[.sortedKeys,.withoutEscapingSlashes])
    return String(decoding:data,as:UTF8.self) + "\n"
}
func commit(_ store:FolderTransactions,_ plan:[Row]) throws {
    var accepted = false
    try store.commit(["projectId":project,"manifest":name,"plan":plan]) {accepted = $0["saved"] as? Bool == true}
    precondition(accepted)
}
func manifest(_ version:String) -> String {
    "{\"kind\":\"project\",\"formatVersion\":\"" + version + "\",\"id\":\"" + project + "\",\"name\":\"Bench\"}\n"
}
let base = manifest("2.0")
try Data(base.utf8).write(to:root.appendingPathComponent(name))
let store = try FolderTransactions(root:root,manifest:name)
let stage = try store.stageAsset(bytes:pdf,owner:project,mediaType:"application/pdf")
let digest = hash(pdf), path = "assets/" + digest
let asset = stage["assetRef"] as! Row, token = stage["assetToken"] as! String
let assetPut:Row = ["path":path,"expected":NSNull(),"assetToken":token]
let update = manifest("2.1")
let value:Row = ["sha256":digest,"byteLength":pdf.count,"title":"Bench PDF","asset":asset]
let row:Row = ["kind":"datasheetRef","id":"018cc251-f400-7001-8000-000000000099","value":value]
let prior = hash(Data(base.utf8))
precondition((try? commit(store,[assetPut,["path":name,"expected":prior,"text":update]])) == nil)
precondition(!fm.fileExists(atPath:root.appendingPathComponent(path).path))
try commit(store,[assetPut,["path":name,"expected":prior,"text":update + line(row)]])
store.close()
let reopened = try FolderTransactions(root:root,manifest:name)
let lease = try reopened.acquire()
defer {try? reopened.release(lease)}
precondition((try? reopened.readAsset(lease:lease,owner:"different-owner",asset:asset,purpose:"pdf proof",offset:0,length:1<<20)) == nil)
let data = try reopened.readAsset(lease:lease,owner:project,asset:asset,purpose:"pdf proof",offset:0,length:1<<20)
precondition(Data(base64Encoded:data["data"] as! String) == pdf && data["eof"] as? Bool == true)
print("PASS native staged PDF proof: refuse asset without owner, write exact bytes with manifest, read matching owner only.")
