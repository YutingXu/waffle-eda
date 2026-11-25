import Foundation
import CoreGraphics
import ImageIO
import UniformTypeIdentifiers

// The stock Altium mark fills 253/256 of its canvas. Terminal and Calculator
// each occupy 206/256 at 50% alpha on the reference Mac.
let input = URL(fileURLWithPath: CommandLine.arguments[1])
let output = URL(fileURLWithPath: CommandLine.arguments[2], isDirectory: true)
let src = CGImageSourceCreateWithURL(input as CFURL, nil)!
let images = (0..<CGImageSourceGetCount(src)).compactMap { CGImageSourceCreateImageAtIndex(src,$0,nil) }
let original = images.max { $0.width < $1.width }!
for points in [16, 32, 128, 256, 512] {
    for scale in [1, 2] {
        let n = points * scale
        let context = CGContext(data:nil, width:n, height:n, bitsPerComponent:8, bytesPerRow:n*4,
                                space:CGColorSpace(name:CGColorSpace.sRGB)!,
                                bitmapInfo:CGImageAlphaInfo.premultipliedLast.rawValue)!
        let side = CGFloat(n) * 206.0 / 253.0
        let edge = (CGFloat(n) - side) / 2
        context.interpolationQuality = .high
        context.draw(original, in:CGRect(x:edge,y:edge,width:side,height:side))
        let name = "icon_\(points)x\(points)" + (scale == 2 ? "@2x" : "") + ".png"
        let file = CGImageDestinationCreateWithURL(output.appendingPathComponent(name) as CFURL,
                                                    UTType.png.identifier as CFString,1,nil)!
        CGImageDestinationAddImage(file,context.makeImage()!,nil)
        if !CGImageDestinationFinalize(file) { exit(1) }
    }
}
