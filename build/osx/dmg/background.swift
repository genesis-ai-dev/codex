import AppKit

let width = 620
let height = 320
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
    (title as NSString).draw(in: NSRect(x: 12, y: 239, width: width - 24, height: 45),
        withAttributes: [.font: NSFont.systemFont(ofSize: 22, weight: .medium),
                         .foregroundColor: NSColor(white: 0.12, alpha: 1), .paragraphStyle: paragraph])
    NSColor(white: 0.38, alpha: 1).setStroke()
    let arrow = NSBezierPath()
    arrow.lineWidth = 4
    arrow.lineCapStyle = .round
    arrow.lineJoinStyle = .round
    arrow.move(to: NSPoint(x: 277, y: 145))
    arrow.line(to: NSPoint(x: 343, y: 145))
    arrow.move(to: NSPoint(x: 330, y: 158))
    arrow.line(to: NSPoint(x: 343, y: 145))
    arrow.line(to: NSPoint(x: 330, y: 132))
    arrow.stroke()
    let filename = scale == 1 ? "background.png" : "background@2x.png"
    try bitmap.representation(using: .png, properties: [:])!.write(
        to: URL(fileURLWithPath: CommandLine.arguments[2]).appendingPathComponent(filename))
}
