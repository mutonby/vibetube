import XCTest
import CoreVideo
@testable import RecordMatte

final class MatteUpsamplerTests: XCTestCase {
    private func pixels(_ width: Int, _ height: Int, gray: Bool, value: (Int, Int) -> UInt8) -> CVPixelBuffer {
        var buffer: CVPixelBuffer?
        CVPixelBufferCreate(nil, width, height, gray ? kCVPixelFormatType_OneComponent8 : kCVPixelFormatType_32BGRA,
                            [kCVPixelBufferIOSurfacePropertiesKey: [:]] as CFDictionary, &buffer)
        let result = buffer!
        CVPixelBufferLockBaseAddress(result, [])
        let bytes = CVPixelBufferGetBaseAddress(result)!.assumingMemoryBound(to: UInt8.self)
        let stride = CVPixelBufferGetBytesPerRow(result), channels = gray ? 1 : 4
        for y in 0..<height { for x in 0..<width {
            let v = value(x, y), index = y * stride + x * channels
            bytes[index] = v
            if !gray { bytes[index + 1] = v; bytes[index + 2] = v; bytes[index + 3] = 255 }
        } }
        CVPixelBufferUnlockBaseAddress(result, [])
        return result
    }
    func testKeepsOpaqueAndTransparentRegionsAtFullHD() throws {
        let frame = pixels(1920, 1080, gray: false) { x, _ in UInt8(x % 256) }
        let upsampler = MatteUpsampler()
        for v: UInt8 in [0, 255] {
            let alpha = pixels(288, 512, gray: true) { _, _ in v }
            let output = try upsampler.refine(alpha: alpha, frame: frame)
            XCTAssertEqual(output.count, 960 * 540)
            XCTAssertTrue(output.allSatisfy { abs(Int($0) - Int(v)) <= 1 })
        }
    }
    func testDiagonalFollowsGuideWithoutFlippingOrBlockSteps() throws {
        let w = 960, h = 540
        func coverage(_ x: Int, _ y: Int, _ width: Int, _ height: Int) -> UInt8 {
            let edge = (10.0 + 210.0 * Double(y) / Double(height)) * Double(width) / 288.0
            return UInt8(max(0, min(1, Double(x) - edge + 0.5)) * 255)
        }
        let alpha = pixels(288, 512, gray: true) { coverage($0, $1, 288, 512) }
        let frame = pixels(1920, 1080, gray: false) { coverage($0, $1, 1920, 1080) }
        let output = try MatteUpsampler().refine(alpha: alpha, frame: frame)
        var squaredError = 0.0, count = 0
        for y in 10..<h-10 {
            for x in 1..<w where output[y*w+x] >= 128 && output[y*w+x-1] < 128 {
                let a = Int(output[y*w+x-1]), b = Int(output[y*w+x])
                let position = Double(x-1) + Double(128-a) / Double(b-a)
                let expected = (10.0 + 210.0 * Double(y) / Double(h)) * Double(w) / 288.0
                squaredError += pow(position - expected, 2); count += 1; break
            }
        }
        XCTAssertEqual(count, h-20)
        XCTAssertLessThan(sqrt(squaredError / Double(count)), 0.8)
    }
}
