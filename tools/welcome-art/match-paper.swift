// match-paper.swift <in.png> <out.png> <bgHex> [--measure] [--round] [--key]
// The welcome art is a painting on paper whose edges fade to transparent, so it reads as a drawing on the screen
// itself. That only holds when the paper is exactly the screen's background colour and the fade carries that colour
// too: a paper a few steps off shows as a square, and light pixels left in the fade show as a white border.
// This shifts paper-coloured pixels (and only those: the drawing stays opaque and unchanged) onto the background
// colour and gives the fade the background colour. --round (the night painting, whose paper is a navy sky glow, not a
// flat colour) also eases that paper onto the background in a circle, so the glow never reaches the square's edges.
// --key (the day painting) then makes the paper itself transparent: whatever is within a few steps of the paper goes
// fully see-through and the alpha comes back smoothly by 24 steps, so the drawing stays opaque (light parts of it are
// never see-through) while the screen shows its own colour wherever there is paper. A device that draws the picture's
// colours a step differently from its own background (simulator measurement, 2026-11-27) then shows no square. --measure only prints how far the art, laid over the background,
// strays from it along the edges, where only paper should be (the check scripts/welcome-art.test.ts runs).
import Foundation; import CoreGraphics; import ImageIO; import UniformTypeIdentifiers

let args = CommandLine.arguments
let measureOnly = args.contains("--measure")
let round = args.contains("--round")
let key = args.contains("--key")
let img = CGImageSourceCreateImageAtIndex(CGImageSourceCreateWithURL(URL(fileURLWithPath: args[1]) as CFURL, nil)!, 0, nil)!
let hex = UInt32(args[3], radix: 16)!
let bg = [Int((hex >> 16) & 255), Int((hex >> 8) & 255), Int(hex & 255)]
let w = img.width, h = img.height
let cs = CGColorSpace(name: CGColorSpace.sRGB)!
var px = [UInt8](repeating: 0, count: w * h * 4)
let ctx = CGContext(data: &px, width: w, height: h, bitsPerComponent: 8, bytesPerRow: w * 4, space: cs,
                    bitmapInfo: CGImageAlphaInfo.premultipliedLast.rawValue)!
ctx.draw(img, in: CGRect(x: 0, y: 0, width: w, height: h))

func rgb(_ i: Int) -> [Int] {
  let a = Int(px[i + 3]); if a == 0 { return bg }
  return (0..<3).map { min(255, (Int(px[i + $0]) * 255 + a / 2) / a) }
}
func dist(_ a: [Int], _ b: [Int]) -> Int { zip(a, b).map { abs($0 - $1) }.max()! }

// The paper: the commonest opaque colour.
var counts: [Int: Int] = [:]
for i in stride(from: 0, to: px.count, by: 4) where px[i + 3] == 255 {
  counts[(Int(px[i]) << 16) | (Int(px[i + 1]) << 8) | Int(px[i + 2]), default: 0] += 1
}
let pk = counts.max { $0.value < $1.value }!.key
let paper = [(pk >> 16) & 255, (pk >> 8) & 255, pk & 255]
let delta = (0..<3).map { bg[$0] - paper[$0] }
let reach = 24  // colours within this many steps of the paper are paper (texture); the drawing is far outside it

// Composite over the background. A border or a square is a step along a whole edge, so take the median of every row
// and column of the outer band (the drawing reaches into the band here and there; a median ignores it) and report
// the worst one, as the largest per-channel distance from the background.
func measure() -> (worst: Int, at: String) {
  let band = Int(Double(min(w, h)) * 0.2)
  // Only what the drawing sits on: the fade, and opaque pixels within reach of the paper (or of the background).
  func diff(_ x: Int, _ y: Int) -> Int? {
    let i = (y * w + x) * 4; let a = Int(px[i + 3]); let c = rgb(i)
    if a == 255 && min(dist(c, paper), dist(c, bg)) >= reach { return nil }
    return dist((0..<3).map { (c[$0] * a + bg[$0] * (255 - a) + 127) / 255 }, bg)
  }
  func median(_ v: [Int?]) -> Int { let s = v.compactMap { $0 }.sorted(); return s.isEmpty ? 0 : s[s.count / 2] }
  var worst = 0, at = ""
  for k in 0..<band {
    let lines: [(String, [Int?])] = [
      ("row \(k)", (0..<w).map { diff($0, k) }), ("row \(h - 1 - k)", (0..<w).map { diff($0, h - 1 - k) }),
      ("col \(k)", (0..<h).map { diff(k, $0) }), ("col \(w - 1 - k)", (0..<h).map { diff(w - 1 - k, $0) }),
    ]
    for (name, v) in lines { let m = median(v); if m > worst { worst = m; at = name } }
  }
  return (worst, at)
}

if measureOnly { let m = measure(); print("worst edge-line median distance \(m.worst) at \(m.at)"); exit(0) }

print("paper \(paper) -> background \(bg)")

for i in stride(from: 0, to: px.count, by: 4) {
  let a = Int(px[i + 3]); if a == 0 { continue }
  var c = rgb(i)
  let d = dist(c, paper)
  let greyish = c.max()! - c.min()! <= 12
  if a < 255 && (d <= 10 || (a < 64 && greyish && d <= 3 * reach)) {
    // The fade, where it is paper (or the faint light or dark fringe at its outer edge): exactly the background
    // colour, so whatever its alpha the screen shows the background. Shading that reaches into the fade keeps its colour.
    c = bg
  } else if d < reach && !round {
    // The paper's texture moves with it in full (so it stays centred on the background); the shift then eases out
    // towards the drawing.
    let k = d <= 8 ? 1.0 : Double(reach - d) / Double(reach - 8)
    c = (0..<3).map { max(0, min(255, c[$0] + Int((Double(delta[$0]) * k).rounded()))) }
  }
  if round && c.max()! < 96 {
    // Distance from the centre, 1 at the middle of an edge; the paper keeps its colour inside 0.62 and is the
    // background by 0.92, on a smooth curve.
    let p = (i / 4); let x = Double(p % w) / Double(w - 1) * 2 - 1, y = Double(p / w) / Double(h - 1) * 2 - 1
    let r = (x * x + y * y).squareRoot()
    let t = max(0, min(1, (r - 0.62) / (0.92 - 0.62))); let keep = 1 - t * t * (3 - 2 * t)
    // Sky: every dark pixel (the glow, the darkest grass); bright drawing (stars, windows, the phone) keeps its colour.
    let paperness = max(0, min(1, Double(96 - c.max()!) / 40))
    let m = 1 - paperness * (1 - keep)
    c = (0..<3).map { Int((Double(bg[$0]) + Double(c[$0] - bg[$0]) * m).rounded()) }
  }
  var na = a
  if key {
    let dp = dist(c, bg)
    let keep = dp <= 6 ? 0.0 : min(1.0, Double(dp - 6) / Double(reach - 6))
    na = Int((Double(a) * keep).rounded())
  }
  px[i + 3] = UInt8(na)
  for j in 0..<3 { px[i + j] = UInt8((c[j] * na + 127) / 255) }
}
let m = measure(); print("after: worst edge-line median distance \(m.worst) at \(m.at)")
let out = CGContext(data: &px, width: w, height: h, bitsPerComponent: 8, bytesPerRow: w * 4, space: cs,
                    bitmapInfo: CGImageAlphaInfo.premultipliedLast.rawValue)!.makeImage()!
let dst = CGImageDestinationCreateWithURL(URL(fileURLWithPath: args[2]) as CFURL, UTType.png.identifier as CFString, 1, nil)!
CGImageDestinationAddImage(dst, out, nil); CGImageDestinationFinalize(dst)
