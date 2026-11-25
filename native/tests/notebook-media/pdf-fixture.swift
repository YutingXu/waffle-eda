// Synthetic two-page PDF for the native notebook-media tests.
import Foundation

func makePDF() -> Data {
    let paint = "1 0 0 rg 10 20 50 30 re f\n0 1 0 rg 60 20 50 30 re f\n0 0 1 rg 10 50 50 30 re f\n1 1 0 rg 60 50 50 30 re f\n"
    let obj = ["<< /Type /Catalog /Pages 2 0 R >>", "<< /Type /Pages /Count 2 /Kids [3 0 R 4 0 R] >>",
               "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 120 100] /Resources << >> >>",
               "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 120 100] /CropBox [10 20 110 80] /Rotate 90 /UserUnit 2 /Resources << >> /Contents 5 0 R >>",
               "<< /Length \(paint.utf8.count) >>\nstream\n\(paint)endstream"]
    var text = "%PDF-1.7\n", offsets = [0]
    for (i, body) in obj.enumerated() {
        offsets.append(text.utf8.count)
        text += "\(i+1) 0 obj\n\(body)\nendobj\n"
    }
    let xref = text.utf8.count
    text += "xref\n0 \(offsets.count)\n0000000000 65535 f \n"
    for offset in offsets.dropFirst() { text += String(format: "%010d 00000 n \n", offset) }
    text += "trailer\n<< /Size \(offsets.count) /Root 1 0 R >>\nstartxref\n\(xref)\n%%EOF\n"
    return Data(text.utf8)
}

try makePDF().write(to: URL(fileURLWithPath: CommandLine.arguments[1]), options: .withoutOverwriting)
