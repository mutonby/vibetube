import CoreVideo
import Foundation
import Vision

final class PersonPresence {
    private let request = VNDetectHumanRectanglesRequest()
    private var recovery = PresenceRecovery()
    private var nextCheck: TimeInterval = 0

    func shouldRestart(for buffer: CVPixelBuffer) -> Bool {
        let now = ProcessInfo.processInfo.systemUptime
        guard now >= nextCheck else { return false }
        nextCheck = now + 0.5
        let present: Bool?
        do {
            try VNImageRequestHandler(cvPixelBuffer: buffer, orientation: .up).perform([request])
            present = request.results?.contains { $0.confidence >= 0.5 } ?? false
        } catch { present = nil }
        return recovery.observe(present, at: now)
    }
}
