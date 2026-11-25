// Pure codecs for data the caller already possesses. Folder grants and raw storage belong to FolderTransactions.
import Foundation
import ImageIO
import CoreGraphics
import CryptoKit
import UniformTypeIdentifiers

enum NotebookMedia {
    struct Failure: LocalizedError {
        let text: String
        var errorDescription: String? { text }
        init(_ text: String) { self.text = text }
    }
    static let queue = DispatchQueue(label: "org.waffle.notebook.media", qos: .userInitiated)
    private static let rgb = CGColorSpace(name: CGColorSpace.sRGB)!
    static func perform(_ request: [String:Any]) throws -> [String:Any] {
        guard let encoded = request["data"] as? String, !encoded.isEmpty, encoded.utf8.count <= 179_000_000,
              let data = Data(base64Encoded: encoded), data.count <= 128 * 1048576 else {throw Failure("Invalid media input size.")}
        if let digest = request["sha256"] as? String {
            guard digest.count == 64, SHA256.hash(data: data).map({String(format:"%02x",$0)}).joined() == digest else {throw Failure("Image integrity check failed.")}
        }
        return try perform(request, data: data)
    }
    static func perform(_ request: [String:Any], data: Data) throws -> [String:Any] {
        let op = request["op"] as? String ?? "", side = request["side"] as? Int ?? 1200
        guard (1...4096).contains(side), data.count > 0, data.count <= 128 * 1048576 else {throw Failure("Unsupported media size.")}
        if op == "pdfInfo" || op == "pdfPage" {
            guard data.prefix(1024).range(of: Data("%PDF-".utf8)) != nil, let provider = CGDataProvider(data:data as CFData),
                  let doc = CGPDFDocument(provider), (1...100000).contains(doc.numberOfPages) else {throw Failure("This PDF could not be read.")}
            guard !doc.isEncrypted || doc.isUnlocked else {throw Failure("This datasheet requires a password.")}
            if op == "pdfInfo" { return ["pages":doc.numberOfPages] }
            guard let index = request["page"] as? Int, (1...doc.numberOfPages).contains(index),
                  let page = doc.page(at:index), let uv = request["region"] as? [Int], uv.count == 4,
                  uv.allSatisfy({(0...1000000).contains($0)}), uv[0]<uv[2], uv[1]<uv[3] else {throw Failure("Invalid datasheet page or region.")}
            return try render(page, uv: uv, side: side)
        }
        guard op == "info" || op == "decode", let source = CGImageSourceCreateWithData(data as CFData, nil),
              let uti = CGImageSourceGetType(source) as String?, let media = request["mediaType"] as? String,
              ["image/jpeg":["public.jpeg"],"image/png":["public.png"],"image/webp":["org.webmproject.webp"],"image/gif":["com.compuserve.gif"],
               "image/heic":["public.heic","public.heif","public.heics","public.heifs"],"image/heif":["public.heic","public.heif","public.heics","public.heifs"]][media]?.contains(uti) == true,
              let props = CGImageSourceCopyPropertiesAtIndex(source,0,nil) as? [CFString:Any],
              let iw = props[kCGImagePropertyPixelWidth] as? Int, let ih = props[kCGImagePropertyPixelHeight] as? Int,
              (1...100000).contains(iw), (1...100000).contains(ih), iw*ih<=120000000 else {throw Failure("Unsupported image codec or dimensions.")}
        let turn = props[kCGImagePropertyOrientation] as? Int ?? 1
        let extent = (5...8).contains(turn) ? [ih,iw]:[iw,ih]
        if op == "info" {return ["extent":extent,"mediaType":media]}
        let cap = min(side,Int(Double(max(iw,ih))*min(1,sqrt(Double(8*1048576)/Double(iw*ih)))))
        let options:[CFString:Any]=[kCGImageSourceCreateThumbnailFromImageAlways:true,kCGImageSourceCreateThumbnailWithTransform:true,
                                     kCGImageSourceShouldCacheImmediately:true,kCGImageSourceThumbnailMaxPixelSize:max(1,cap)]
        guard let image = CGImageSourceCreateThumbnailAtIndex(source,0,options as CFDictionary), image.width*image.height<=8*1048576 else {throw Failure("The image could not be decoded.")}
        let w=image.width, h=image.height
        var rgba=Data(count:w*h*4)
        let done=rgba.withUnsafeMutableBytes { mem -> Bool in
            guard let ctx=CGContext(data:mem.baseAddress,width:w,height:h,bitsPerComponent:8,bytesPerRow:4*w,
                                    space:rgb,bitmapInfo:CGImageAlphaInfo.premultipliedLast.rawValue) else {return false}
            ctx.draw(image,in:CGRect(x:0,y:0,width:w,height:h))
            let p=mem.bindMemory(to:UInt8.self)
            for i in stride(from:0,to:p.count,by:4) where p[i+3] > 0 && p[i+3] < 255 {
                let a=Int(p[i+3])
                for j in i..<(i+3) {p[j]=UInt8(min(255,(Int(p[j])*255+a/2)/a))}
            }
            return true
        }
        guard done else {throw Failure("Image preview allocation failed.")}
        var out:[String:Any]=["width":w,"height":h,"extent":extent,"rgba":rgba.base64EncodedString()]
        if request["png"] as? Bool == true {
            let png=try encodePNG(image)
            if png.count<=8<<20 {out["png"]=png.base64EncodedString()}
        }
        return out
    }
    private static func render(_ page:CGPDFPage, uv:[Int], side:Int) throws -> [String:Any] {
        let box=page.getBoxRect(.cropBox), quarter=abs(page.rotationAngle)%180==90
        var unit:CGFloat=1
        if let dict=page.dictionary {var u:CGFloat=1;if CGPDFDictionaryGetNumber(dict,"UserUnit",&u){unit=u}}
        let bw=quarter ? box.height:box.width, bh=quarter ? box.width:box.height
        let physical=[bw*unit,bh*unit]
        guard unit.isFinite,unit>0,physical.allSatisfy({$0.isFinite && $0>0 && $0<=10000000}) else {throw Failure("Unsupported PDF page dimensions.")}
        let r=uv.map {CGFloat($0)/1000000}, rw=physical[0]*(r[2]-r[0]), rh=physical[1]*(r[3]-r[1])
        let scale=min(CGFloat(side)/max(rw,rh),sqrt(CGFloat(8*1048576)/(rw*rh)),32)
        let w=max(1,Int((rw*scale).rounded())), h=max(1,Int((rh*scale).rounded()))
        guard w*h<=8*1048576, let ctx=CGContext(data:nil,width:w,height:h,bitsPerComponent:8,bytesPerRow:4*w,
                                                   space:rgb,bitmapInfo:CGImageAlphaInfo.premultipliedLast.rawValue) else {throw Failure("PDF preview allocation failed.")}
        ctx.setFillColor(CGColor(gray:1,alpha:1));ctx.fill(CGRect(x:0,y:0,width:w,height:h))
        ctx.translateBy(x:-r[0]*physical[0]*scale,y:-(1-r[3])*physical[1]*scale)
        ctx.scaleBy(x:unit*scale,y:unit*scale)
        ctx.concatenate(page.getDrawingTransform(.cropBox,rect:CGRect(x:0,y:0,width:bw,height:bh),rotate:0,preserveAspectRatio:true))
        ctx.drawPDFPage(page)
        guard let image=ctx.makeImage() else {throw Failure("PDF preview failed.")}
        return ["width":w,"height":h,"physical":physical,"png":try encodePNG(image).base64EncodedString()]
    }
    private static func encodePNG(_ image:CGImage) throws -> Data {
        let out=NSMutableData()
        guard let writer=CGImageDestinationCreateWithData(out,UTType.png.identifier as CFString,1,nil) else {throw Failure("PNG encoder unavailable.")}
        CGImageDestinationAddImage(writer,image,nil)
        guard CGImageDestinationFinalize(writer) else {throw Failure("PNG encoding failed.")}
        return out as Data
    }
}
