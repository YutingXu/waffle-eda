// The same verified PDF, scoped clip renderer and atomic folder writer used by the editor.
import Foundation
import CoreGraphics
import ImageIO
import CryptoKit

typealias Row = [String:Any]
let fm = FileManager.default
let scratch = fm.temporaryDirectory.appendingPathComponent("waffle-media-transaction-"+UUID().uuidString)
try fm.createDirectory(at:scratch,withIntermediateDirectories:false)
defer {try? fm.removeItem(at:scratch)}
let projectID="fixture-project", owner="fixture-sheet", manifest="Notebook.waffle", member="Notebook.wsch"
let queue=DispatchQueue(label:"notebook-test-folder")
let store=try FolderTransactions(root:scratch,manifest:manifest)
let source=try Data(contentsOf:URL(fileURLWithPath:CommandLine.arguments[1]))
func hash(_ d:Data)->String {SHA256.hash(data:d).map {String(format:"%02x",$0)}.joined()}
func line(_ o:Row)throws->String {
    let d=try JSONSerialization.data(withJSONObject:o,options:[.sortedKeys,.withoutEscapingSlashes])
    return String(decoding:d,as:UTF8.self)+"\n"
}
func call(_ action:String,_ options:Row)throws->Row {
    let done=DispatchSemaphore(value:0)
    var result:Result<Row,Error>?
    var args=options
    args["grant"]=store.grant
    if args["ownerId"] == nil {args["ownerId"]=owner}
    NotebookFolderMedia.run(action:action,request:args,queue:queue,resolve:{grant in
        guard grant==store.grant else {throw NotebookMedia.Failure("Invalid fixture grant.")}
        return store
    },complete:{value in result=value;done.signal()})
    precondition(done.wait(timeout:.now()+15) == .success)
    return try result!.get()
}
func commit(_ s:FolderTransactions,_ plan:[Row])throws{
    var acknowledged=false
    try s.commit(["projectId":projectID,"manifest":manifest,"plan":plan]) {acknowledged=$0["saved"] as? Bool == true}
    precondition(acknowledged)
}
func read(_ s:FolderTransactions,_ ref:Row,_ id:String=owner)throws->Data {
    let lease=try s.acquire()
    defer {try? s.release(lease)}
    let row=try s.readAsset(lease:lease,owner:id,asset:ref,purpose:"notebook-check",offset:0,length:1<<20)
    return Data(base64Encoded:row["data"] as! String)!
}
let hdr=try line(["kind":"schematic","formatVersion":"2.0","id":owner])
let meta=try line(["kind":"project","formatVersion":"2.0","id":projectID,"name":"Notebook"])+line(["kind":"document","id":owner,"docKind":"schematic","name":"Notebook","path":member])
try commit(store,[["path":member,"expected":NSNull(),"text":hdr],["path":manifest,"expected":NSNull(),"text":meta]])
let raw=try call("notebookTransfer",["origin":"drop","mediaType":"application/pdf","data":source.base64EncodedString()])
let sourceRef=raw["assetRef"] as! Row,sourceToken=raw["assetToken"] as! String
let region=[100000,100000,400000,400000]
let clipArgs:Row=["assetRef":sourceRef,"assetToken":sourceToken,"page":2,"region":region,"side":120]
let denied = (try? call("notebookClip",clipArgs.merging(["ownerId":"another-sheet"]){_,n in n})) == nil
precondition(denied && sourceRef["sha256"] as! String==hash(source))
let clip=try call("notebookClip",clipArgs),clipRef=clip["assetRef"] as! Row,clipToken=clip["assetToken"] as! String
let w=clip["width"] as! Int,h=clip["height"] as! Int
precondition(w==72 && h==120 && clipRef["mediaType"] as! String=="image/png")
let row=try line(["kind":"image","id":"fixture-clip","asset":clipRef,"name":"chips.pdf","extent":[w,h],"at":[1000000,2000000],
                  "size":[7200000,12000000],"clip":["source":sourceRef,"name":"chips.pdf","page":2,"region":region] as Row])
let rawPath="assets/"+(sourceRef["sha256"] as! String),clipPath="assets/"+(clipRef["sha256"] as! String)
precondition(!fm.fileExists(atPath:scratch.appendingPathComponent(rawPath).path) && !fm.fileExists(atPath:scratch.appendingPathComponent(clipPath).path))
try commit(store,[["path":rawPath,"expected":NSNull(),"assetToken":sourceToken],["path":clipPath,"expected":NSNull(),"assetToken":clipToken],
                  ["path":member,"expected":hash(Data(hdr.utf8)),"text":hdr+row]])
let reopened=try FolderTransactions(root:scratch,manifest:manifest)
let original=try read(reopened,sourceRef),png=try read(reopened,clipRef)
let saved=try String(contentsOf:scratch.appendingPathComponent(member),encoding:.utf8)
let manifestBytes=try String(contentsOf:scratch.appendingPathComponent(manifest),encoding:.utf8)
precondition(saved==hdr+row && manifestBytes==meta && original==source && hash(png)==clipRef["sha256"] as! String)
let image=CGImageSourceCreateImageAtIndex(CGImageSourceCreateWithData(png as CFData,nil)!,0,nil)!
let space=CGColorSpace(name:CGColorSpace.sRGB)!
let c=CGContext(data:nil,width:w,height:h,bitsPerComponent:8,bytesPerRow:w*4,space:space,bitmapInfo:CGImageAlphaInfo.premultipliedLast.rawValue)!
c.draw(image,in:CGRect(x:0,y:0,width:w,height:h))
let pixels=c.data!.assumingMemoryBound(to:UInt8.self)
for i in 0..<(w*h){precondition(pixels[4*i]>250 && pixels[4*i+1]<5 && pixels[4*i+2]<5 && pixels[4*i+3]==255)}
for (missing,present,path) in [(sourceRef,clipRef,rawPath),(clipRef,sourceRef,clipPath)] {
    let from=scratch.appendingPathComponent(path),aside=scratch.appendingPathComponent("disconnected-fixture")
    try fm.moveItem(at:from,to:aside)
    precondition((try? read(reopened,missing)) == nil)
    let other=try read(reopened,present)
    precondition(hash(other)==present["sha256"] as! String)
    try fm.moveItem(at:aside,to:from)
}
print("Saved and reopened the original PDF and a \(w)×\(h) red page-2 clip in one transaction. Independent source/snapshot loss and owner checks passed.")
