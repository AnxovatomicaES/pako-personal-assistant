// Draws Pako's app icon (the panel's orb on a dark rounded square) as a 1024 px PNG, at build time: build.sh turns it into AppIcon.icns with
// sips and iconutil. Usage: icon <out.png>. A drawing rather than a file in the repository, so there is no binary to keep in step.

import AppKit

let out = CommandLine.arguments.count > 1 ? CommandLine.arguments[1] : "icon.png"
let size = 1024
guard let rep = NSBitmapImageRep(bitmapDataPlanes: nil, pixelsWide: size, pixelsHigh: size, bitsPerSample: 8, samplesPerPixel: 4,
                                 hasAlpha: true, isPlanar: false, colorSpaceName: .deviceRGB, bytesPerRow: 0, bitsPerPixel: 0) else { exit(1) }
NSGraphicsContext.saveGraphicsState()
NSGraphicsContext.current = NSGraphicsContext(bitmapImageRep: rep)
let s = CGFloat(size)
// Apple's icon grid: a 824 px square with rounded corners in the middle of the 1024 px canvas.
let tile = NSRect(x: 100, y: 100, width: 824, height: 824)
let back = NSBezierPath(roundedRect: tile, xRadius: 185, yRadius: 185)
NSGradient(starting: NSColor(red: 0.09, green: 0.09, blue: 0.16, alpha: 1), ending: NSColor(red: 0.027, green: 0.031, blue: 0.051, alpha: 1))?
    .draw(in: back, angle: -90)
// The glow behind the orb, then the orb: the colours of the panel's favicon (src/panel/signin-local.html).
let glow = NSGradient(colors: [NSColor(red: 0.29, green: 0.24, blue: 1, alpha: 0.55), NSColor(red: 0.29, green: 0.24, blue: 1, alpha: 0)])
back.addClip()
glow?.draw(in: NSBezierPath(ovalIn: NSRect(x: s / 2 - 380, y: s / 2 - 380, width: 760, height: 760)), relativeCenterPosition: .zero)
let orb = NSBezierPath(ovalIn: NSRect(x: s / 2 - 270, y: s / 2 - 270, width: 540, height: 540))
let colors = [NSColor.white, NSColor(red: 0.62, green: 0.55, blue: 1, alpha: 1), NSColor(red: 0.29, green: 0.24, blue: 1, alpha: 1),
              NSColor(red: 0, green: 0.76, blue: 1, alpha: 1)]
NSGradient(colors: colors, atLocations: [0, 0.25, 0.6, 1], colorSpace: .deviceRGB)?.draw(in: orb, relativeCenterPosition: NSPoint(x: -0.3, y: 0.4))
NSGraphicsContext.restoreGraphicsState()
guard let png = rep.representation(using: .png, properties: [:]) else { exit(1) }
do { try png.write(to: URL(fileURLWithPath: out)) } catch { exit(1) }
