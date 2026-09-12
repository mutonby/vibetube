import CoreImage
import CoreML
import CoreVideo
import Foundation

// EdgeSAM's published preprocessing and point decoder, used once at calibration.
// Its binary selection seeds MatAnyone2; it never filters the video matte.
final class SelectionSeed {
    static func mask(frame: CVPixelBuffer, points: [Double], width: Int, height: Int) throws -> [Float] {
        let dir = URL(fileURLWithPath: CommandLine.arguments[0]).deletingLastPathComponent()
        let config = MLModelConfiguration(); config.computeUnits = .all
        let encoder = try MLModel(contentsOf: dir.appendingPathComponent("edge_sam_encoder.mlmodelc"), configuration: config)
        let decoder = try MLModel(contentsOf: dir.appendingPathComponent("edge_sam_decoder.mlmodelc"), configuration: config)
        let w = CVPixelBufferGetWidth(frame), h = CVPixelBufferGetHeight(frame)
        let scale = 1024.0 / Double(max(w, h))
        let rw = Int(Double(w) * scale + 0.5), rh = Int(Double(h) * scale + 0.5)
        var pixels = [UInt8](repeating: 0, count: rw * rh * 4)
        let image = CIImage(cvPixelBuffer: frame).transformed(by: CGAffineTransform(scaleX: Double(rw) / Double(w), y: Double(rh) / Double(h)))
        let context = CIContext(options: [.cacheIntermediates: false])
        pixels.withUnsafeMutableBytes {
            context.render(image, toBitmap: $0.baseAddress!, rowBytes: rw * 4,
                           bounds: CGRect(x: 0, y: 0, width: rw, height: rh), format: .RGBA8,
                           colorSpace: CGColorSpace(name: CGColorSpace.sRGB)!)
        }
        let tensor = try MLMultiArray(shape: [1, 3, 1024, 1024], dataType: .float32)
        let values = tensor.dataPointer.assumingMemoryBound(to: Float.self)
        values.update(repeating: 0, count: tensor.count)
        let mean: [Float] = [123.675, 116.28, 103.53], std: [Float] = [58.395, 57.12, 57.375]
        for y in 0..<rh { for x in 0..<rw { for c in 0..<3 {
            values[c * 1024 * 1024 + y * 1024 + x] = (Float(pixels[(y * rw + x) * 4 + c]) - mean[c]) / std[c]
        }}}
        let encoded = try encoder.prediction(from: MLDictionaryFeatureProvider(dictionary: ["image": tensor]))
        guard let embedding = encoded.featureValue(for: "image_embeddings")?.multiArrayValue else { throw failure("encoder") }
        let coords = try MLMultiArray(shape: [1, 3, 2], dataType: .float32)
        let labels = try MLMultiArray(shape: [1, 3], dataType: .float32)
        for i in 0..<2 {
            coords[i * 2] = NSNumber(value: points[i * 2] * Double(rw))
            coords[i * 2 + 1] = NSNumber(value: points[i * 2 + 1] * Double(rh))
            labels[i] = 1
        }
        coords[4] = 0; coords[5] = 0; labels[2] = -1
        let decoded = try decoder.prediction(from: MLDictionaryFeatureProvider(dictionary: [
            "image_embeddings": embedding, "point_coords": coords, "point_labels": labels,
        ]))
        guard let scores = decoded.featureValue(for: "scores")?.multiArrayValue,
              let masks = decoded.featureValue(for: "masks")?.multiArrayValue,
              masks.shape.count == 4, masks.shape[2].intValue == 256, masks.shape[3].intValue == 256,
              scores.count == masks.shape[1].intValue, scores.count > 0 else { throw failure("decoder") }
        let best = (0..<scores.count).max { scores[$0].floatValue < scores[$1].floatValue }!
        let strides = masks.strides.map(\.intValue)
        func sample(_ x: Int, _ y: Int) -> Float {
            masks[best * strides[1] + min(255, max(0, y)) * strides[2] + min(255, max(0, x)) * strides[3]].floatValue
        }
        // Resize logits before thresholding, respecting the encoder's bottom/right padding.
        var seed = [Float](repeating: 0, count: width * height)
        for y in 0..<height { for x in 0..<width {
            let sx = (Double(x) + 0.5) / Double(width) * Double(rw) / 4 - 0.5
            let sy = (Double(y) + 0.5) / Double(height) * Double(rh) / 4 - 0.5
            let ix = Int(floor(sx)), iy = Int(floor(sy)), fx = Float(sx - floor(sx)), fy = Float(sy - floor(sy))
            let top = sample(ix, iy) * (1 - fx) + sample(ix + 1, iy) * fx
            let bottom = sample(ix, iy + 1) * (1 - fx) + sample(ix + 1, iy + 1) * fx
            seed[y * width + x] = top * (1 - fy) + bottom * fy > 0 ? 1 : 0
        }}
        guard seed.contains(1) else { throw failure("selección vacía") }
        return seed
    }
    private static func failure(_ detail: String) -> NSError {
        NSError(domain: "SelectionSeed", code: 1, userInfo: [NSLocalizedDescriptionKey: "No se pudo calcular la selección: \(detail)"])
    }
}
