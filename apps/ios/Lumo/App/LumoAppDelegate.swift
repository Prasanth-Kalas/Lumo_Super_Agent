import UIKit
import UserNotifications

/// Bridges `UIApplicationDelegate` callbacks (which SwiftUI's @main
/// App scene doesn't expose directly) to the notification stack.
///
/// LumoApp constructs the live `NotificationService` and
/// `BackgroundFetchService` and installs them on the delegate via
/// `install(notificationService:backgroundFetch:)` from its init.
/// Then SwiftUI wires this delegate via `@UIApplicationDelegateAdaptor`.
///
/// Responsibilities:
///  - Set `UNUserNotificationCenter.delegate` to the notification
///    service (so the foreground / tap delegate methods route).
///  - Register `BGTaskScheduler` task on launch.
///  - Forward APNs token callbacks to `NotificationService.submitDeviceToken`.
///  - Re-schedule the BGTask on app-entering-background.

final class LumoAppDelegate: NSObject, UIApplicationDelegate {
    private(set) var notificationService: NotificationServicing?
    private(set) var backgroundFetch: BackgroundFetchScheduling?

    func install(
        notificationService: NotificationServicing,
        backgroundFetch: BackgroundFetchScheduling
    ) {
        self.notificationService = notificationService
        self.backgroundFetch = backgroundFetch
        if let real = notificationService as? NotificationService {
            UNUserNotificationCenter.current().delegate = real
        }
    }

    // MARK: - UIApplicationDelegate

    func application(
        _ application: UIApplication,
        didFinishLaunchingWithOptions launchOptions: [UIApplication.LaunchOptionsKey: Any]?
    ) -> Bool {
        // Register categories regardless of authorization — the OS lets
        // us pre-register so when the user later grants, the action
        // buttons are immediately available.
        notificationService?.registerCategories()
        // Register the background fetch task. MUST happen before
        // didFinishLaunching returns or BGTaskScheduler refuses the
        // identifier.
        backgroundFetch?.register()
        return true
    }

    func applicationDidEnterBackground(_ application: UIApplication) {
        // Schedule a follow-up so the system has something to fire
        // even if the in-flight task was cancelled.
        backgroundFetch?.scheduleNext()
    }

    func application(
        _ application: UIApplication,
        didRegisterForRemoteNotificationsWithDeviceToken deviceToken: Data
    ) {
        Task { [notificationService] in
            do {
                _ = try await notificationService?.submitDeviceToken(deviceToken)
            } catch {
                // Non-fatal — the device just won't receive pushes
                // until the next registration attempt. Surface in
                // logs for sandbox debugging.
                print("[notif] submitDeviceToken failed: \(error.localizedDescription)")
            }
        }
    }

    func application(
        _ application: UIApplication,
        didFailToRegisterForRemoteNotificationsWithError error: Error
    ) {
        print("[notif] APNs registration failed: \(error.localizedDescription)")
    }
}
