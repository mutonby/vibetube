import Foundation
import CoreVideo
import MatAnyoneKitCoreML
import Darwin

// Binary stdin: width/height/format/color flags (LE UInt32), then pixels.
// format 0 = RGBA8; 1 = NV12. Color flags: bit 0 = BT.709, bit 1 = full range.
// stdout: kind/width/height/microseconds (LE UInt32); kind 0 = ready,
// kind 1 = matte, kind 2 = no person seeded; both include alpha8 bytes.
// kind 3 = matte after losing a guided selection on reentry; renew the selection.
// Preserve memory while present; reacquire after a confirmed exit and return.
let input = FileHandle.standardInput, output = FileHandle.standardOutput
func readExactly(_ count: Int) throws -> Data? {
    // Read directly into the final allocation. FileHandle + Data.append copied
    // each pipe fragment again for every multi-megabyte camera frame.
    var result = Data(count: count)
    let length = try result.withUnsafeMutableBytes { bytes -> Int in
        var offset = 0
        while offset < count {
            let n = Darwin.read(input.fileDescriptor, bytes.baseAddress!.advanced(by: offset), count - offset)
            if n < 0 {
                if errno == EINTR { continue }
                throw NSError(domain: NSPOSIXErrorDomain, code: Int(errno))
            }
            if n == 0 { break }
            offset += n
        }
        return offset
    }
    if length == 0 { return nil }
    guard length == count else { throw NSError(domain: "RecordMatte", code: 1, userInfo: [NSLocalizedDescriptionKey: "Truncated camera frame"]) }
    return result
}
func send(_ kind: UInt32, _ width: Int, _ height: Int, _ micros: UInt32, _ payload: Data = Data()) {
    var header = Data()
    for var n in [kind, UInt32(width), UInt32(height), micros].map({ $0.littleEndian }) {
        withUnsafeBytes(of: &n) { header.append(contentsOf: $0) }
    }
    output.write(header); if !payload.isEmpty { output.write(payload) }
}
guard var matte = MatAnyoneMatte() else {
    FileHandle.standardError.write(Data("MatAnyone2: no se pudieron cargar los modelos\n".utf8)); exit(1)
}
let presence = PersonPresence()
let upsampler = MatteUpsampler()
var args = Array(CommandLine.arguments.dropFirst())
var offlineFps: Double?
var frameIndex = 0
if args.first == "--fps" {
    guard args.count >= 2, let fps = Double(args[1]), fps.isFinite, fps >= 1, fps <= 120 else { exit(2) }
    offlineFps = fps; args.removeFirst(2)
}
var selection: [Double]?
var selectionLost = false
if !args.isEmpty {
    let values = args.compactMap(Double.init)
    guard values.count == 4, args.count == 4, values.allSatisfy({ $0.isFinite && $0 >= 0 && $0 <= 1 }) else { exit(2) }
    selection = values
}
send(0, matte.workingWidth, matte.workingHeight, 0)
do {
    while let header = try readExactly(16) {
        let w = Int(header.withUnsafeBytes { UInt32(littleEndian: $0.loadUnaligned(fromByteOffset: 0, as: UInt32.self)) })
        let h = Int(header.withUnsafeBytes { UInt32(littleEndian: $0.loadUnaligned(fromByteOffset: 4, as: UInt32.self)) })
        let format = header.withUnsafeBytes { UInt32(littleEndian: $0.loadUnaligned(fromByteOffset: 8, as: UInt32.self)) }
        let flags = header.withUnsafeBytes { UInt32(littleEndian: $0.loadUnaligned(fromByteOffset: 12, as: UInt32.self)) }
        guard w > 0, h > 0, w <= 1920, h <= 1080, format <= 1, flags <= 7,
              format == 0 || (w % 2 == 0 && h % 2 == 0),
              let pixels = try readExactly(format == 0 ? w * h * 4 : w * h * 3 / 2) else { throw NSError(domain: "RecordMatte", code: 2) }
        let seedMask = flags & 4 != 0 ? try readExactly(matte.workingWidth * matte.workingHeight) : nil
        if flags & 4 != 0 && seedMask == nil { throw NSError(domain: "RecordMatte", code: 2) }
        try autoreleasepool {
            let start = Date()
            let buffer = try cameraPixelBuffer(width: w, height: h, pixels: pixels, format: format, colorFlags: flags & 3)
            if presence.shouldRestart(for: buffer, at: offlineFps.map { Double(frameIndex) / $0 }) {
                guard let fresh = MatAnyoneMatte() else {
                    throw NSError(domain: "RecordMatte", code: 4, userInfo: [NSLocalizedDescriptionKey: "No se pudo recuperar el seguimiento"])
                }
                matte = fresh
                selectionLost = !args.isEmpty
                FileHandle.standardError.write(Data("MatAnyone2: nueva sesión tras salir y volver\n".utf8))
            }
            var alpha: CVPixelBuffer?
            if let seedMask {
                alpha = try matte.seedSelection(buffer, mask: seedMask.map { Float($0) / 255 }).alpha
            } else if let points = selection {
                let mask = try SelectionSeed.mask(frame: buffer, points: points, width: matte.workingWidth, height: matte.workingHeight)
                alpha = try matte.seedSelection(buffer, mask: mask).alpha
                selection = nil
            } else { matte.matte(buffer) { alpha = $0.alpha } }
            let size = MatteUpsampler.dimensions(width: w, height: h)
            let bytes = try alpha.map { try upsampler.refine(alpha: $0, frame: buffer) } ?? Data(count: size.width * size.height)
            // No person yet: transparent foreground, never expose the raw room.
            let micros = UInt32(min(Date().timeIntervalSince(start)*1_000_000, Double(UInt32.max)))
            send(alpha == nil ? 2 : (selectionLost ? 3 : 1), size.width, size.height, micros, bytes)
            if seedMask == nil { frameIndex += 1 }
        }
    }
} catch {
    FileHandle.standardError.write(Data("MatAnyone2: \(error)\n".utf8)); exit(1)
}
