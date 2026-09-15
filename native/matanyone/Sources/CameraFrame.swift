import CoreVideo
import Foundation
import Accelerate

// Accept camera-native NV12 to avoid RGB conversion and 8 MB/frame readbacks in
// Chromium. RGBA remains available for calibration stills and other sources.
func cameraPixelBuffer(width: Int, height: Int, pixels: Data, format: UInt32, colorFlags: UInt32) throws -> CVPixelBuffer {
    let nv12 = format == 1
    guard format <= 1, colorFlags <= 3, width > 0, height > 0,
          !nv12 || (width % 2 == 0 && height % 2 == 0),
          pixels.count == (nv12 ? width * height * 3 / 2 : width * height * 4) else {
        throw NSError(domain: "RecordMatte", code: 2)
    }
    let type = nv12 ? (colorFlags & 2 == 0 ? kCVPixelFormatType_420YpCbCr8BiPlanarVideoRange : kCVPixelFormatType_420YpCbCr8BiPlanarFullRange) : kCVPixelFormatType_32BGRA
    var result: CVPixelBuffer?
    guard CVPixelBufferCreate(nil, width, height, type, [kCVPixelBufferIOSurfacePropertiesKey: [:]] as CFDictionary, &result) == kCVReturnSuccess,
          let buffer = result else { throw NSError(domain: "RecordMatte", code: 3) }
    if nv12 {
        CVBufferSetAttachment(buffer, kCVImageBufferYCbCrMatrixKey,
                              colorFlags & 1 == 0 ? kCVImageBufferYCbCrMatrix_ITU_R_601_4 : kCVImageBufferYCbCrMatrix_ITU_R_709_2, .shouldPropagate)
    }
    CVPixelBufferLockBaseAddress(buffer, [])
    defer { CVPixelBufferUnlockBaseAddress(buffer, []) }
    pixels.withUnsafeBytes { bytes in
        if nv12 {
            var offset = 0
            for plane in 0..<2 {
                let target = CVPixelBufferGetBaseAddressOfPlane(buffer, plane)!
                let stride = CVPixelBufferGetBytesPerRowOfPlane(buffer, plane)
                let rows = plane == 0 ? height : height / 2
                for y in 0..<rows {
                    target.advanced(by: y * stride).copyMemory(from: bytes.baseAddress!.advanced(by: offset + y * width), byteCount: width)
                }
                offset += rows * width
            }
        } else {
            var source = vImage_Buffer(data: UnsafeMutableRawPointer(mutating: bytes.baseAddress!), height: vImagePixelCount(height), width: vImagePixelCount(width), rowBytes: width * 4)
            var target = vImage_Buffer(data: CVPixelBufferGetBaseAddress(buffer)!, height: vImagePixelCount(height), width: vImagePixelCount(width), rowBytes: CVPixelBufferGetBytesPerRow(buffer))
            let channels: [UInt8] = [2, 1, 0, 3]
            channels.withUnsafeBufferPointer { map in
                _ = vImagePermuteChannels_ARGB8888(&source, &target, map.baseAddress!, vImage_Flags(kvImageNoFlags))
            }
        }
    }
    return buffer
}
