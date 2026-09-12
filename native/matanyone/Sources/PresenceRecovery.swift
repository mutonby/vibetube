import Foundation

// Debounce person-presence observations, not matte pixels. A brief missed
// detection must not throw away a good tracking session.
struct PresenceRecovery {
    private var absentSince: TimeInterval?
    private var presentSince: TimeInterval?
    private var awaitingReturn = false

    mutating func observe(_ present: Bool?, at time: TimeInterval) -> Bool {
        guard let present else {
            absentSince = nil; presentSince = nil
            return false
        }
        if !present {
            presentSince = nil
            if absentSince == nil { absentSince = time }
            if time - absentSince! >= 1 { awaitingReturn = true }
            return false
        }
        absentSince = nil
        guard awaitingReturn else { return false }
        if presentSince == nil { presentSince = time }
        guard time - presentSince! >= 0.5 else { return false }
        awaitingReturn = false; presentSince = nil
        return true
    }
}
