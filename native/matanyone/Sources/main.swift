import Foundation
import CoreVideo
import MatAnyoneKitCoreML
import Darwin
import Accelerate

// Binary stdin: width/height (LE UInt32), then top-down RGBA8.
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
let args = Array(CommandLine.arguments.dropFirst())
var selection: [Double]?
var selectionLost = false
if !args.isEmpty {
    let values = args.compactMap(Double.init)
    guard values.count == 4, args.count == 4, values.allSatisfy({ $0.isFinite && $0 >= 0 && $0 <= 1 }) else { exit(2) }
    selection = values
}
send(0, matte.workingWidth, matte.workingHeight, 0)
do {
    while let header = try readExactly(8) {
        let w = Int(header.withUnsafeBytes { UInt32(littleEndian: $0.loadUnaligned(fromByteOffset: 0, as: UInt32.self)) })
        let h = Int(header.withUnsafeBytes { UInt32(littleEndian: $0.loadUnaligned(fromByteOffset: 4, as: UInt32.self)) })
        guard w > 0, h > 0, w <= 1920, h <= 1080,
              let rgba = try readExactly(w * h * 4) else { throw NSError(domain: "RecordMatte", code: 2) }
        try autoreleasepool {
            let start = Date()
            var buffer: CVPixelBuffer?
            let attrs = [kCVPixelBufferIOSurfacePropertiesKey: [:]] as CFDictionary
            guard CVPixelBufferCreate(nil, w, h, kCVPixelFormatType_32BGRA, attrs, &buffer) == kCVReturnSuccess,
                  let buffer else { throw NSError(domain: "RecordMatte", code: 3) }
            CVPixelBufferLockBaseAddress(buffer, [])
            let dst = CVPixelBufferGetBaseAddress(buffer)!.assumingMemoryBound(to: UInt8.self)
            let stride = CVPixelBufferGetBytesPerRow(buffer)
            rgba.withUnsafeBytes { bytes in
                var source = vImage_Buffer(data: UnsafeMutableRawPointer(mutating: bytes.baseAddress!), height: vImagePixelCount(h), width: vImagePixelCount(w), rowBytes: w * 4)
                var target = vImage_Buffer(data: dst, height: vImagePixelCount(h), width: vImagePixelCount(w), rowBytes: stride)
                let channels: [UInt8] = [2, 1, 0, 3]
                channels.withUnsafeBufferPointer { map in
                    _ = vImagePermuteChannels_ARGB8888(&source, &target, map.baseAddress!, vImage_Flags(kvImageNoFlags))
                }
            }
            CVPixelBufferUnlockBaseAddress(buffer, [])
            if presence.shouldRestart(for: buffer) {
                guard let fresh = MatAnyoneMatte() else {
                    throw NSError(domain: "RecordMatte", code: 4, userInfo: [NSLocalizedDescriptionKey: "No se pudo recuperar el seguimiento"])
                }
                matte = fresh
                selectionLost = !args.isEmpty
                FileHandle.standardError.write(Data("MatAnyone2: nueva sesión tras salir y volver\n".utf8))
            }
            var alpha: CVPixelBuffer?
            if let points = selection {
                let mask = try SelectionSeed.mask(frame: buffer, points: points, width: matte.workingWidth, height: matte.workingHeight)
                alpha = try matte.seedSelection(buffer, mask: mask).alpha
                selection = nil
            } else { matte.matte(buffer) { alpha = $0.alpha } }
            var bytes = Data(count: matte.workingWidth * matte.workingHeight)
            if let alpha {
                CVPixelBufferLockBaseAddress(alpha, .readOnly)
                let base = CVPixelBufferGetBaseAddress(alpha)!, row = CVPixelBufferGetBytesPerRow(alpha)
                bytes.withUnsafeMutableBytes { dest in
                    for y in 0..<matte.workingHeight {
                        dest.baseAddress!.advanced(by: y*matte.workingWidth)
                            .copyMemory(from: base.advanced(by: y*row), byteCount: matte.workingWidth)
                    }
                }
                CVPixelBufferUnlockBaseAddress(alpha, .readOnly)
            }
            // No person yet: transparent foreground, never expose the raw room.
            let micros = UInt32(min(Date().timeIntervalSince(start)*1_000_000, Double(UInt32.max)))
            send(alpha == nil ? 2 : (selectionLost ? 3 : 1), matte.workingWidth, matte.workingHeight, micros, bytes)
        }
    }
} catch {
    FileHandle.standardError.write(Data("MatAnyone2: \(error)\n".utf8)); exit(1)
}
