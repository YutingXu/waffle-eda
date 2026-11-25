import AVFoundation
import CoreGraphics
import ImageIO
import Foundation

let dir = URL(fileURLWithPath: CommandLine.arguments[1], isDirectory:true)
let out = URL(fileURLWithPath: CommandLine.arguments[2])
struct Frame: Decodable { let file:String; let ms:Double }
let frames = try JSONDecoder().decode([Frame].self, from: Data(contentsOf:dir.appendingPathComponent("frames.json")))
func load(_ f:Frame) -> CGImage {
    CGImageSourceCreateImageAtIndex(CGImageSourceCreateWithURL(dir.appendingPathComponent(f.file) as CFURL,nil)!,0,nil)!
}
let first=load(frames.first!), width=first.width, height=first.height
let writer = try AVAssetWriter(outputURL:out,fileType:.mp4)
let video = AVAssetWriterInput(mediaType:.video,outputSettings:[AVVideoCodecKey:AVVideoCodecType.h264,
    AVVideoWidthKey:width, AVVideoHeightKey:height, AVVideoCompressionPropertiesKey:[AVVideoAverageBitRateKey:2700000]])
let adaptor=AVAssetWriterInputPixelBufferAdaptor(assetWriterInput:video,sourcePixelBufferAttributes:[
    kCVPixelBufferPixelFormatTypeKey as String:kCVPixelFormatType_32BGRA, kCVPixelBufferWidthKey as String:width, kCVPixelBufferHeightKey as String:height])
writer.add(video); guard writer.startWriting() else {fatalError(writer.error!.localizedDescription)};writer.startSession(atSourceTime:.zero)
let colors=CGColorSpaceCreateDeviceRGB()
for f in frames {try autoreleasepool {
    guard writer.status == .writing else {throw writer.error!}
    while !video.isReadyForMoreMediaData {Thread.sleep(forTimeInterval:0.002)}
    var buf:CVPixelBuffer?
    guard CVPixelBufferPoolCreatePixelBuffer(nil,adaptor.pixelBufferPool!,&buf) == kCVReturnSuccess,let b=buf else {fatalError("pixel buffer")}
    CVPixelBufferLockBaseAddress(b,[]); let ctx=CGContext(data:CVPixelBufferGetBaseAddress(b),width:width,height:height,bitsPerComponent:8,bytesPerRow:CVPixelBufferGetBytesPerRow(b),space:colors,bitmapInfo:CGImageAlphaInfo.premultipliedFirst.rawValue|CGBitmapInfo.byteOrder32Little.rawValue)!
    ctx.draw(load(f),in:CGRect(x:0,y:0,width:width,height:height));CVPixelBufferUnlockBaseAddress(b,[])
    guard adaptor.append(b,withPresentationTime:CMTime(value:Int64((f.ms*600).rounded()),timescale:600000)) else {fatalError(writer.error!.localizedDescription)}
}}
video.markAsFinished();let done=DispatchSemaphore(value:0);writer.finishWriting{done.signal()};done.wait()
guard writer.status == .completed else {fatalError(writer.error!.localizedDescription)}
print("Encoded \(frames.count) editor frames, \(width)×\(height), at original sample timestamps.")
