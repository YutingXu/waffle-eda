// Only the folder queue resolves grants or stages immutable bytes. Image/PDF
// decoding runs on its own queue so a large page does not suspend an unrelated save.
import Foundation
import CryptoKit
import ImageIO

enum NotebookFolderMedia {
    private typealias Fail = NotebookMedia.Failure
    private static let maxBytes = 128 * 1048576
    private static func read(_ request:[String:Any], store:FolderTransactions, owner:String, all:Bool) throws -> Data {
        guard let ref=request["assetRef"] as? [String:Any],let size=ref["byteLength"] as? Int,(1...maxBytes).contains(size) else {throw Fail("Invalid attachment size.")}
        let token=request["assetToken"] as? String,lease=token == nil ? try store.acquire() : nil
        var data=Data()
        do {
            repeat {
                let chunk=try store.readAsset(lease:lease,stagedToken:token,owner:owner,asset:ref,purpose:"notebook-preview",
                                              offset:data.count,length:all ? min(1<<20,size-data.count) : 1)
                guard let encoded=chunk["data"] as? String,let decoded=Data(base64Encoded:encoded),!decoded.isEmpty else {throw Fail("Incomplete attachment.")}
                data.append(decoded)
            } while all && data.count<size
            if let lease=lease {try store.release(lease)}
            return data
        } catch {if let lease=lease {try? store.release(lease)};throw error}
    }
    private static func pngSize(_ data:Data) throws -> (Int,Int) {
        guard data.count>=24,data.starts(with:[137,80,78,71,13,10,26,10]),data[12..<16].elementsEqual("IHDR".utf8) else {throw Fail("A PNG thumbnail was expected.")}
        let number:(Range<Int>)->Int = {r in r.reduce(0){$0*256+Int(data[$1])}}
        let w=number(16..<20),h=number(20..<24)
        guard (1...4096).contains(w),(1...4096).contains(h),w*h<=8*1048576 else {throw Fail("Invalid thumbnail dimensions.")}
        return (w,h)
    }
    private static func checkTransfer(_ data:Data,media:String) throws {
        if media=="application/pdf" {
            guard data.prefix(1024).range(of:Data("%PDF-".utf8)) != nil else {throw Fail("The selected PDF signature does not match.")}
        } else if media=="image/svg+xml" {
            let head=String(decoding:data.prefix(8192),as:UTF8.self)
            guard head.range(of:#"^\s*(?:<\?xml[^>]*>\s*)?(?:<!--[\s\S]*?-->\s*)*<svg(?:\s|>)"#,options:.regularExpression) != nil else {throw Fail("The selected SVG signature does not match.")}
        } else {
            _=try NotebookMedia.perform(["op":"info","mediaType":media],data:data)
        }
    }
    static func run(action:String, request:[String:Any], queue:DispatchQueue, resolve:@escaping(String)throws->FolderTransactions,
                    complete:@escaping(Result<[String:Any],Error>)->Void) {
        guard let grant=request["grant"] as? String,let owner=request["ownerId"] as? String,!owner.isEmpty,owner.utf8.count<=1024 else {complete(.failure(Fail("Choose an editable sheet first.")));return}
        let fail:(Error)->Void = {complete(.failure($0))}
        func install(_ bytes:Data,media:String,width:Int?=nil,height:Int?=nil,verify:Bool=false) {
            queue.async {
                do {
                    let store=try resolve(grant)
                    if verify {_=try read(request,store:store,owner:owner,all:false)}
                    var out=try store.stageAsset(bytes:bytes,owner:owner,mediaType:media)
                    if let w=width,let h=height {out["width"]=w;out["height"]=h}
                    complete(.success(out))
                } catch {fail(error)}
            }
        }
        if action=="notebookTransfer" {
            NotebookMedia.queue.async {
                do {
                    guard ["drop","paste","camera"].contains(request["origin"] as? String ?? ""),
                          let media=request["mediaType"] as? String,let text=request["data"] as? String,
                          !text.isEmpty,text.utf8.count<=179_000_000,let bytes=Data(base64Encoded:text),bytes.count<=maxBytes else {throw Fail("Invalid selected media transfer.")}
                    try checkTransfer(bytes,media:media);install(bytes,media:media)
                } catch {fail(error)}
            }
            return
        }
        queue.async {
            do {
                let store=try resolve(grant)
                if action=="notebookDerivative" {
                    guard let ref=request["assetRef"] as? [String:Any],let hash=ref["sha256"] as? String,
                          let side=request["side"] as? Int,[128,256,512,1024,2048,4096].contains(side),
                          let op=request["op"] as? String,["read","write"].contains(op) else {throw Fail("Invalid thumbnail request.")}
                    _=try read(request,store:store,owner:owner,all:false)
                    let variant="screen-v1-s"+String(side)
                    if op=="read" {
                        guard let data=try store.readImageDerivative(digest:hash,variant:variant),let (w,h)=try? pngSize(data),max(w,h)<=side else {complete(.success([:]));return}
                        let digest=SHA256.hash(data:data).map{String(format:"%02x",$0)}.joined()
                        complete(.success(["png":data.base64EncodedString(),"sha256":digest]))
                    } else {
                        guard let encoded=request["png"] as? String,encoded.utf8.count<=11_184_812,let data=Data(base64Encoded:encoded),data.count<=8<<20 else {throw Fail("Invalid thumbnail.")}
                        let (w,h)=try pngSize(data)
                        guard max(w,h)<=side else {throw Fail("Invalid thumbnail scale.")}
                        try store.writeImageDerivative(digest:hash,variant:variant,png:data);complete(.success(["saved":true]))
                    }
                    return
                }
                guard action=="notebookClip",let ref=request["assetRef"] as? [String:Any],ref["mediaType"] as? String=="application/pdf" else {throw Fail("Select a source datasheet.")}
                let bytes=try read(request,store:store,owner:owner,all:true)
                NotebookMedia.queue.async {
                    do {
                        var args=request;args["op"]="pdfPage"
                        let rendered=try NotebookMedia.perform(args,data:bytes)
                        guard let encoded=rendered["png"] as? String,let png=Data(base64Encoded:encoded) else {throw Fail("The selected region could not be encoded.")}
                        let (w,h)=try pngSize(png);install(png,media:"image/png",width:w,height:h,verify:true)
                    } catch {fail(error)}
                }
            } catch {fail(error)}
        }
    }
}
