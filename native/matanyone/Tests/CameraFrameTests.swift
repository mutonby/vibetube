import XCTest
import CoreImage
import CoreVideo
@testable import RecordMatte

final class CameraFrameTests: XCTestCase {
    func testNV12PlaneStrideAndRange() throws {
        let context = CIContext(options: [.workingColorSpace: NSNull(), .outputColorSpace: NSNull()])
        for full: UInt32 in [0, 2] {
            let black: UInt8 = full == 0 ? 16 : 0, white: UInt8 = full == 0 ? 235 : 255
            let data = Data([black, white, black, white, black, white, black, white, 128, 128, 128, 128])
            let frame = try cameraPixelBuffer(width: 4, height: 2, pixels: data, format: 1, colorFlags: full | 1)
            XCTAssertEqual(CVPixelBufferGetPlaneCount(frame), 2)
            var rgba = Data(count: 4 * 2 * 4)
            rgba.withUnsafeMutableBytes { b in
                context.render(CIImage(cvPixelBuffer: frame, options: [.colorSpace: NSNull()]), toBitmap: b.baseAddress!, rowBytes: 16,
                               bounds: CGRect(x: 0, y: 0, width: 4, height: 2), format: .RGBA8, colorSpace: nil)
            }
            for pixel in 0..<8 {
                for channel in 0..<3 {
                    XCTAssertLessThanOrEqual(abs(Int(rgba[pixel * 4 + channel]) - (pixel % 2 == 0 ? 0 : 255)), 3)
                }
            }
        }
    }
    func testRGBAPreservesChannels() throws {
        let frame = try cameraPixelBuffer(width: 2, height: 1, pixels: Data([255, 20, 40, 255, 10, 200, 60, 255]), format: 0, colorFlags: 0)
        CVPixelBufferLockBaseAddress(frame, .readOnly)
        defer { CVPixelBufferUnlockBaseAddress(frame, .readOnly) }
        let pixels = CVPixelBufferGetBaseAddress(frame)!.assumingMemoryBound(to: UInt8.self)
        XCTAssertEqual(Array(UnsafeBufferPointer(start: pixels, count: 8)), [40, 20, 255, 255, 60, 200, 10, 255])
    }
    func testRejectsTruncatedOrOddNV12() {
        XCTAssertThrowsError(try cameraPixelBuffer(width: 4, height: 2, pixels: Data(count: 11), format: 1, colorFlags: 1))
        XCTAssertThrowsError(try cameraPixelBuffer(width: 3, height: 2, pixels: Data(count: 9), format: 1, colorFlags: 1))
    }
}
