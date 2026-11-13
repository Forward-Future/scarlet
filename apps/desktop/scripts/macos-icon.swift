// Renders assets/icon.svg onto Apple's macOS icon grid: an 824px rounded square
// centred on a 1024px canvas with a soft drop shadow, so Scarlet sits at the same
// size as other apps in the Dock. Windows icons stay full-bleed.
//
//   swift apps/desktop/scripts/macos-icon.swift out.png
//   pnpm --filter @scarlet/desktop tauri icon out.png -o /tmp/icons   # then copy the macOS files
import AppKit

let out = CommandLine.arguments.count > 1 ? CommandLine.arguments[1] : "icon-macos.png"
let canvas = 1024.0, tile = 824.0, inset = (canvas - tile) / 2
let scale = tile / 64 // the SVG is drawn on a 64-unit square

let rep = NSBitmapImageRep(bitmapDataPlanes: nil, pixelsWide: Int(canvas), pixelsHigh: Int(canvas),
                           bitsPerSample: 8, samplesPerPixel: 4, hasAlpha: true, isPlanar: false,
                           colorSpaceName: .deviceRGB, bytesPerRow: 0, bitsPerPixel: 0)!
NSGraphicsContext.saveGraphicsState()
NSGraphicsContext.current = NSGraphicsContext(bitmapImageRep: rep)

let rect = NSRect(x: inset, y: inset, width: tile, height: tile)
let shape = NSBezierPath(roundedRect: rect, xRadius: 14 * scale, yRadius: 14 * scale)
NSGraphicsContext.saveGraphicsState()
let shadow = NSShadow()
shadow.shadowColor = NSColor.black.withAlphaComponent(0.3)
shadow.shadowOffset = NSSize(width: 0, height: -10)
shadow.shadowBlurRadius = 20
shadow.set()
NSColor(srgbRed: 0x93 / 255.0, green: 0x33 / 255.0, blue: 0xea / 255.0, alpha: 1).setFill()
shape.fill()
NSGraphicsContext.restoreGraphicsState()

// <text x="32" y="32" dy="0.35em" font-size="32" font-weight="600">S</text>
let font = NSFont.systemFont(ofSize: 32 * scale, weight: .semibold)
let text = NSAttributedString(string: "S", attributes: [.font: font, .foregroundColor: NSColor.white])
let baseline = canvas / 2 - 0.35 * font.pointSize // SVG y grows down, AppKit y grows up
text.draw(at: NSPoint(x: canvas / 2 - text.size().width / 2, y: baseline + font.descender))

NSGraphicsContext.restoreGraphicsState()
try! rep.representation(using: .png, properties: [:])!.write(to: URL(fileURLWithPath: out))
