import CoreImage
import CoreVideo
import Foundation

// Reconstruct the model's low-resolution alpha using the very same camera
// frame as a guide. Core Image preserves image edges without chair/hair rules,
// thresholding the matte, or adding temporal state outside MatAnyone2.
final class MatteUpsampler {
    private let context = CIContext(options: [.workingColorSpace: NSNull(), .outputColorSpace: NSNull()])

    static func dimensions(width: Int, height: Int) -> (width: Int, height: Int) {
        let scale = min(1, 960.0 / Double(width), 540.0 / Double(height))
        return (max(1, Int((Double(width) * scale).rounded())), max(1, Int((Double(height) * scale).rounded())))
    }

    func refine(alpha: CVPixelBuffer, frame: CVPixelBuffer) throws -> Data {
        guard let filter = CIFilter(name: "CIGuidedFilter") else {
            throw NSError(domain: "RecordMatte", code: 5, userInfo: [NSLocalizedDescriptionKey: "CIGuidedFilter no está disponible"])
        }
        filter.setValue(CIImage(cvPixelBuffer: alpha, options: [.colorSpace: NSNull()]), forKey: kCIInputImageKey)
        let width = CVPixelBufferGetWidth(frame), height = CVPixelBufferGetHeight(frame)
        // The guide only refines alpha; the recorded RGB image stays untouched.
        // Bound this filter's work so Full HD capture does not multiply its cost.
        let scale = min(1, 960.0 / Double(width), 540.0 / Double(height))
        let guide = CIImage(cvPixelBuffer: frame, options: [.colorSpace: NSNull()])
            .transformed(by: CGAffineTransform(scaleX: scale, y: scale))
        filter.setValue(guide, forKey: "inputGuideImage")
        filter.setValue(2, forKey: "inputRadius")
        filter.setValue(0.001, forKey: "inputEpsilon")
        guard let refined = filter.outputImage else {
            throw NSError(domain: "RecordMatte", code: 6, userInfo: [NSLocalizedDescriptionKey: "No se pudo refinar el contorno"])
        }
        let size = Self.dimensions(width: width, height: height)
        var bytes = Data(count: size.width * size.height)
        bytes.withUnsafeMutableBytes { target in
            context.render(refined, toBitmap: target.baseAddress!, rowBytes: size.width,
                           bounds: CGRect(x: 0, y: 0, width: size.width, height: size.height), format: .L8, colorSpace: nil)
        }
        return bytes
    }
}
