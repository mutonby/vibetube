import XCTest
@testable import RecordMatte

final class PresenceRecoveryTests: XCTestCase {
    func testContinuousPresenceDoesNotReset() {
        var recovery = PresenceRecovery()
        for time in stride(from: 0.0, through: 120.0, by: 0.5) {
            XCTAssertFalse(recovery.observe(true, at: time))
        }
    }
    func testBriefMissDoesNotReset() {
        var recovery = PresenceRecovery()
        XCTAssertFalse(recovery.observe(false, at: 0))
        XCTAssertFalse(recovery.observe(false, at: 0.5))
        XCTAssertFalse(recovery.observe(true, at: 1))
        XCTAssertFalse(recovery.observe(true, at: 2))
    }
    func testExitAndReturnResetOncePerVisit() {
        var recovery = PresenceRecovery()
        for start in [0.0, 10.0] {
            XCTAssertFalse(recovery.observe(false, at: start))
            XCTAssertFalse(recovery.observe(false, at: start + 1))
            XCTAssertFalse(recovery.observe(true, at: start + 2))
            XCTAssertTrue(recovery.observe(true, at: start + 2.5))
            XCTAssertFalse(recovery.observe(true, at: start + 3))
        }
    }
    func testAnErrorIsNotEvidenceOfAbsence() {
        var recovery = PresenceRecovery()
        XCTAssertFalse(recovery.observe(false, at: 0))
        XCTAssertFalse(recovery.observe(nil, at: 1))
        XCTAssertFalse(recovery.observe(false, at: 2))
        XCTAssertFalse(recovery.observe(true, at: 2.5))
        XCTAssertFalse(recovery.observe(true, at: 3))
    }
    func testReturnNeedsConsecutiveDetections() {
        var recovery = PresenceRecovery()
        XCTAssertFalse(recovery.observe(false, at: 0))
        XCTAssertFalse(recovery.observe(false, at: 1))
        XCTAssertFalse(recovery.observe(true, at: 2))
        XCTAssertFalse(recovery.observe(nil, at: 2.5))
        XCTAssertFalse(recovery.observe(true, at: 3))
        XCTAssertTrue(recovery.observe(true, at: 3.5))
    }
}
