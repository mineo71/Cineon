import Foundation
import IOKit.pwr_mgt

/// Keeps the screen on while a film plays, as QuickTime and Safari do. The moment it pauses, ends
/// or stalls, macOS dims and sleeps on its usual schedule again.
final class StayAwake {
    static let reason = "Playing a film in Cineon"

    private var assertion: IOPMAssertionID = 0
    private(set) var isHolding = false

    func hold(_ on: Bool) {
        guard on != isHolding else { return }
        if on {
            var id: IOPMAssertionID = 0
            let result = IOPMAssertionCreateWithName(
                kIOPMAssertionTypePreventUserIdleDisplaySleep as CFString,
                IOPMAssertionLevel(kIOPMAssertionLevelOn),
                Self.reason as CFString,
                &id
            )
            guard result == kIOReturnSuccess else { return }
            assertion = id
            isHolding = true
        } else {
            IOPMAssertionRelease(assertion)
            assertion = 0
            isHolding = false
        }
    }

    deinit {
        if isHolding { IOPMAssertionRelease(assertion) }
    }
}
