import AppKit

let width = 620
let height = 370
// Finder positions icons from the top. AppKit draws from the bottom.
let arrowY = CGFloat(height - 154)
let title = "Drag \(CommandLine.arguments[1]) into Applications to install."
for scale in [1, 2] {
    let bitmap = NSBitmapImageRep(bitmapDataPlanes: nil, pixelsWide: width * scale,
        pixelsHigh: height * scale, bitsPerSample: 8, samplesPerPixel: 4, hasAlpha: true, isPlanar: false,
        colorSpaceName: .deviceRGB, bytesPerRow: 0, bitsPerPixel: 0)!
    bitmap.size = NSSize(width: width, height: height)
    NSGraphicsContext.current = NSGraphicsContext(bitmapImageRep: bitmap)
    NSColor(white: 0.94, alpha: 1).setFill()
    NSBezierPath(rect: NSRect(x: 0, y: 0, width: width, height: height)).fill()
    let paragraph = NSMutableParagraphStyle()
    paragraph.alignment = .center
    (title as NSString).draw(in: NSRect(x: 12, y: height - 81, width: width - 24, height: 45),
        withAttributes: [.font: NSFont.systemFont(ofSize: 22, weight: .medium),
                         .foregroundColor: NSColor(white: 0.12, alpha: 1), .paragraphStyle: paragraph])
    NSColor(white: 0.38, alpha: 1).setStroke()
    let arrow = NSBezierPath()
    arrow.lineWidth = 4
    arrow.lineCapStyle = .round
    arrow.lineJoinStyle = .round
    arrow.move(to: NSPoint(x: 277, y: arrowY))
    arrow.line(to: NSPoint(x: 343, y: arrowY))
    arrow.move(to: NSPoint(x: 330, y: arrowY + 13))
    arrow.line(to: NSPoint(x: 343, y: arrowY))
    arrow.line(to: NSPoint(x: 330, y: arrowY - 13))
    arrow.stroke()
    let filename = scale == 1 ? "background.png" : "background@2x.png"
    try bitmap.representation(using: .png, properties: [:])!.write(
        to: URL(fileURLWithPath: CommandLine.arguments[2]).appendingPathComponent(filename))
}
