import XCTest
@testable import FlagshipAPI
@testable import FlagshipUI

/// Reference counter so the test closures can vary their result per call without
/// capturing a mutable value-type var across the @escaping boundary.
private final class Counter { var n = 0 }

@MainActor
final class SuggestUsernameViewModelTests: XCTestCase {

    func test_load_populatesNameAndArmsCooldown() async {
        let vm = SuggestUsernameViewModel(
            suggest: { _ in .init(name: "happy-otter", retryAfterMs: 2000, throttled: false) }
        )
        await vm.load()
        XCTAssertEqual(vm.current, "happy-otter")
        XCTAssertEqual(vm.cooldownRemaining, 2) // ceil(2000ms)
        XCTAssertFalse(vm.canRegenerate)        // cooling down
        XCTAssertTrue(vm.canContinue)
    }

    func test_load_isIdempotent() async {
        let counter = Counter()
        let vm = SuggestUsernameViewModel(suggest: { _ in
            counter.n += 1
            return .init(name: "name\(counter.n)", retryAfterMs: 0, throttled: false)
        })
        await vm.load()
        await vm.load() // second load is a no-op (we already have a name)
        XCTAssertEqual(counter.n, 1)
        XCTAssertEqual(vm.current, "name1")
    }

    func test_regenerateFetchesNewNameWhenCooldownClear() async {
        let names = ["one-fox", "two-owl", "three-elk"]
        let counter = Counter()
        let vm = SuggestUsernameViewModel(suggest: { _ in
            let n = names[min(counter.n, names.count - 1)]
            counter.n += 1
            return .init(name: n, retryAfterMs: 0, throttled: false) // no cooldown → ready
        })
        await vm.load()
        XCTAssertEqual(vm.current, "one-fox")
        XCTAssertTrue(vm.canRegenerate)
        await vm.regenerate()
        XCTAssertEqual(vm.current, "two-owl")
    }

    func test_regenerateIsAGatedNoOpWhileCoolingDown() async {
        let counter = Counter()
        let vm = SuggestUsernameViewModel(suggest: { _ in
            counter.n += 1
            return .init(name: "name\(counter.n)", retryAfterMs: 2000, throttled: false)
        })
        await vm.load()
        XCTAssertEqual(vm.current, "name1")
        XCTAssertFalse(vm.canRegenerate)
        await vm.regenerate() // gated by the cooldown → no second fetch
        XCTAssertEqual(vm.current, "name1")
        XCTAssertEqual(counter.n, 1)
    }

    func test_throttledResponseKeepsTheNameAndArmsCooldown() async {
        let counter = Counter()
        let vm = SuggestUsernameViewModel(suggest: { _ in
            counter.n += 1
            return counter.n == 1
                ? .init(name: "first-fox", retryAfterMs: 0, throttled: false)
                : .init(name: nil, retryAfterMs: 5000, throttled: true)
        })
        await vm.load()       // first-fox, cooldown clear
        await vm.regenerate() // server says throttled
        XCTAssertEqual(vm.current, "first-fox") // unchanged
        XCTAssertEqual(vm.cooldownRemaining, 5)
    }

    func test_errorSurfacesAndLeavesNoName() async {
        struct Boom: Error {}
        let vm = SuggestUsernameViewModel(suggest: { _ in throw Boom() })
        await vm.load()
        XCTAssertNil(vm.current)
        XCTAssertNotNil(vm.errorText)
        XCTAssertFalse(vm.canContinue)
    }

    func test_newDeviceKeyIs32HexCharsAndVaries() {
        let k = SuggestUsernameViewModel.newDeviceKey()
        XCTAssertEqual(k.count, 32)
        XCTAssertTrue(k.allSatisfy { "0123456789abcdef".contains($0) })
        XCTAssertNotEqual(k, SuggestUsernameViewModel.newDeviceKey())
    }
}
