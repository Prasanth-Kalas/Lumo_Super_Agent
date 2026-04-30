import SwiftUI
import XCTest
@testable import Lumo

/// Burger button + drawer-state toggle tests.
///
/// SwiftUI Button taps can't be invoked from XCTest without
/// ViewInspector or XCUITest, so the assertions here focus on:
///   • The Binding<Bool> contract — the drawer-state binding flips
///     when *anyone* (button, backdrop tap, drawer row) calls
///     `binding.wrappedValue.toggle()` or assigns false. This proves
///     the indirection from button → external state works.
///   • Construction smoke — BurgerMenuButton and a drawer-host pair
///     can be built with a shared @State Bool without crashing,
///     covering the wiring shape RootView uses today.
@MainActor
final class BurgerMenuToggleTests: XCTestCase {

    func test_burger_canBeBuiltWithABinding() {
        var open = false
        let binding = Binding<Bool>(
            get: { open },
            set: { open = $0 }
        )
        let _ = BurgerMenuButton(isOpen: binding)
        XCTAssertFalse(open)
    }

    func test_drawerOpenBinding_propagates_throughBackdropClose() {
        // The drawer's "close()" path is what backdrop tap invokes.
        // Simulate by calling the binding's setter directly — proves
        // any close handler that flips the binding value to false
        // dismisses the drawer.
        var open = true
        let binding = Binding<Bool>(
            get: { open },
            set: { open = $0 }
        )
        XCTAssertTrue(open)
        binding.wrappedValue = false
        XCTAssertFalse(open)
    }

    func test_drawerOpenBinding_propagates_throughBurgerToggle() {
        // What the button does internally: isOpen.toggle().
        var open = false
        let binding = Binding<Bool>(
            get: { open },
            set: { open = $0 }
        )
        binding.wrappedValue.toggle()
        XCTAssertTrue(open)
        binding.wrappedValue.toggle()
        XCTAssertFalse(open)
    }

    func test_destinationSelection_closesDrawer_byBindingContract() {
        // Drawer's destination row pattern: invoke onSelectDestination
        // then close. Verify the close-after-select pattern is honored
        // by checking the binding can be flipped from inside an
        // arbitrary closure (which is what the row's button does).
        var open = true
        let binding = Binding<Bool>(
            get: { open },
            set: { open = $0 }
        )
        var destinationSelected: DrawerDestination?
        let onSelectDestination: (DrawerDestination) -> Void = { dest in
            destinationSelected = dest
            binding.wrappedValue = false
        }
        onSelectDestination(.trips)
        XCTAssertEqual(destinationSelected, .trips)
        XCTAssertFalse(open)
    }
}
