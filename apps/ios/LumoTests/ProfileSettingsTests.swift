import XCTest
@testable import Lumo

/// `ProfileSettings` round-trip + default behavior. Mirrors the shape
/// of `NotificationSettingsTests` so the persistence pattern stays
/// uniform across feature areas.
@MainActor
final class ProfileSettingsTests: XCTestCase {

    private let displayNameKey = "LumoProfile.displayName"
    private let cabinClassKey  = "LumoProfile.cabinClass"
    private let seatPrefKey    = "LumoProfile.seatPreference"

    override func setUp() {
        super.setUp()
        clearAll()
    }

    override func tearDown() {
        clearAll()
        super.tearDown()
    }

    func test_displayName_defaultsToNil() {
        XCTAssertNil(ProfileSettings.displayName)
    }

    func test_displayName_setAndRead() {
        ProfileSettings.displayName = "Alex"
        XCTAssertEqual(ProfileSettings.displayName, "Alex")
    }

    func test_displayName_emptySetClearsValue() {
        ProfileSettings.displayName = "Alex"
        ProfileSettings.displayName = ""
        XCTAssertNil(ProfileSettings.displayName)
    }

    func test_cabinClass_defaultsToNoPreference() {
        XCTAssertEqual(ProfileSettings.cabinClass, .noPreference)
    }

    func test_cabinClass_setAndRead_business() {
        ProfileSettings.cabinClass = .business
        XCTAssertEqual(ProfileSettings.cabinClass, .business)
    }

    func test_cabinClass_settingNoPreferenceClearsBackingStore() {
        ProfileSettings.cabinClass = .first
        ProfileSettings.cabinClass = .noPreference
        XCTAssertEqual(ProfileSettings.cabinClass, .noPreference)
        XCTAssertNil(UserDefaults.standard.string(forKey: cabinClassKey))
    }

    func test_seatPreference_defaultsToNoPreference() {
        XCTAssertEqual(ProfileSettings.seatPreference, .noPreference)
    }

    func test_seatPreference_aisleRoundTrip() {
        ProfileSettings.seatPreference = .aisle
        XCTAssertEqual(ProfileSettings.seatPreference, .aisle)
    }

    func test_cabinClass_unknownRawValueFallsBackToNoPreference() {
        UserDefaults.standard.set("unknown_class", forKey: cabinClassKey)
        XCTAssertEqual(ProfileSettings.cabinClass, .noPreference)
    }

    func test_seatPreference_unknownRawValueFallsBackToNoPreference() {
        UserDefaults.standard.set("middle", forKey: seatPrefKey)
        XCTAssertEqual(ProfileSettings.seatPreference, .noPreference)
    }

    private func clearAll() {
        let d = UserDefaults.standard
        d.removeObject(forKey: displayNameKey)
        d.removeObject(forKey: cabinClassKey)
        d.removeObject(forKey: seatPrefKey)
    }
}
