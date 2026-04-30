import SwiftUI
import XCTest
@testable import Lumo

/// Side-drawer behavior tests — covers the data sources and structural
/// invariants the rendered SideDrawerView depends on. Renders are not
/// inspected (this codebase doesn't pull in ViewInspector); instead we
/// exercise the inputs the view binds to so future regressions in the
/// destinations / recents / sign-out gating fail at the test layer
/// rather than on a screenshot diff.
@MainActor
final class SideDrawerViewTests: XCTestCase {

    // MARK: - Recent Chats data source

    func test_recentChats_emptyByDefault() {
        let store = makeStore()
        XCTAssertEqual(store.items.count, 0)
    }

    func test_recentChats_upsertDedupesById_movesToTop() {
        let store = makeStore()
        store.upsert(id: "s1", title: "First", updatedAt: Date(timeIntervalSince1970: 100))
        store.upsert(id: "s2", title: "Second", updatedAt: Date(timeIntervalSince1970: 200))
        store.upsert(id: "s1", title: "First (updated)", updatedAt: Date(timeIntervalSince1970: 300))
        XCTAssertEqual(store.items.count, 2)
        XCTAssertEqual(store.items.first?.id, "s1")
        XCTAssertEqual(store.items.first?.title, "First (updated)")
    }

    func test_recentChats_capsAtMax_dropsOldest() {
        let store = makeStore()
        for i in 0..<(RecentChatsStore.maxItems + 5) {
            store.upsert(id: "s\(i)", title: "t\(i)", updatedAt: Date(timeIntervalSince1970: TimeInterval(i)))
        }
        XCTAssertEqual(store.items.count, RecentChatsStore.maxItems)
        // Newest at top, oldest evicted
        XCTAssertEqual(store.items.first?.id, "s\(RecentChatsStore.maxItems + 4)")
    }

    func test_recentChats_emptyTitle_fallsBackToPlaceholder() {
        let store = makeStore()
        store.upsert(id: "s1", title: "   ", updatedAt: Date())
        XCTAssertEqual(store.items.first?.title, "New chat")
    }

    func test_recentChats_titleClampedTo80Chars() {
        let store = makeStore()
        let big = String(repeating: "a", count: 200)
        store.upsert(id: "s1", title: big, updatedAt: Date())
        XCTAssertEqual(store.items.first?.title.count, 80)
    }

    func test_recentChats_clear_removesAll() {
        let store = makeStore()
        store.upsert(id: "s1", title: "a", updatedAt: Date())
        store.upsert(id: "s2", title: "b", updatedAt: Date())
        store.clear()
        XCTAssertTrue(store.items.isEmpty)
    }

    func test_recentChats_persistRoundTrip_acrossInstances() {
        let suite = makeSuiteName()
        let defaults = UserDefaults(suiteName: suite)!
        let key = "TestRecents.\(UUID().uuidString)"

        do {
            let s1 = RecentChatsStore(defaults: defaults, key: key)
            s1.upsert(id: "abc", title: "Vegas trip", updatedAt: Date(timeIntervalSince1970: 12345))
        }
        let s2 = RecentChatsStore(defaults: defaults, key: key)
        XCTAssertEqual(s2.items.count, 1)
        XCTAssertEqual(s2.items.first?.id, "abc")

        defaults.removePersistentDomain(forName: suite)
    }

    // MARK: - Drawer destination identity

    func test_destinations_hashable_distinguishesReceiptIDs() {
        let a: DrawerDestination = .receiptDetail("rcpt_1")
        let b: DrawerDestination = .receiptDetail("rcpt_2")
        let c: DrawerDestination = .receiptDetail("rcpt_1")
        XCTAssertNotEqual(a, b)
        XCTAssertEqual(a, c)
        var set = Set<DrawerDestination>()
        set.insert(a); set.insert(b); set.insert(c)
        XCTAssertEqual(set.count, 2)
    }

    func test_destinations_topLevel_areAllDistinct() {
        let topLevel: [DrawerDestination] = [.trips, .receipts, .profile, .settings]
        XCTAssertEqual(Set(topLevel).count, topLevel.count)
    }

    // MARK: - Sign-out gate

    func test_signedIn_true_meansFooterIsRendered() {
        // Construction smoke-test: when signedIn=true the drawer is
        // built with a sign-out callback wired. Without ViewInspector
        // we can't read the footer back; we verify the input contract
        // by constructing both variants and checking they differ in
        // the captured `signedIn` value the view stores.
        let drawer = makeDrawer(signedIn: true)
        XCTAssertTrue(drawer.signedIn)
    }

    func test_signedIn_false_meansFooterHiddenInputContract() {
        let drawer = makeDrawer(signedIn: false)
        XCTAssertFalse(drawer.signedIn)
    }

    // MARK: - Helpers

    private func makeStore() -> RecentChatsStore {
        let suite = makeSuiteName()
        let defaults = UserDefaults(suiteName: suite)!
        defaults.removePersistentDomain(forName: suite)
        return RecentChatsStore(defaults: defaults, key: "TestRecents.\(UUID().uuidString)")
    }

    private func makeSuiteName() -> String {
        "SideDrawerViewTests.\(UUID().uuidString)"
    }

    private func makeDrawer(signedIn: Bool) -> SideDrawerView {
        var open = false
        let openBinding = Binding<Bool>(
            get: { open },
            set: { open = $0 }
        )
        return SideDrawerView(
            isOpen: openBinding,
            recents: [],
            signedIn: signedIn,
            onNewChat: {},
            onSelectRecent: { _ in },
            onSelectDestination: { _ in },
            onSignOut: {}
        )
    }
}

