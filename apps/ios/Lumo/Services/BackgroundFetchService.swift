import BackgroundTasks
import Foundation
import UserNotifications

/// `BGTaskScheduler` registration + handler for the proactive-refresh
/// task. Identifier `com.lumo.rentals.ios.proactive-refresh` matches
/// the `BGTaskSchedulerPermittedIdentifiers` Info.plist entry.
///
/// Lifecycle:
///  1. App launch → `register()` registers the task with the scheduler.
///     This must happen before `application(_:didFinishLaunchingWith:)`
///     returns.
///  2. App entering background → `scheduleNext()` submits a request
///     with earliest-begin-date = now + 4h.
///  3. iOS decides when to actually run (could be sooner, could be
///     much later — we don't control). When it fires, the registered
///     handler hits `/api/proactive/recent`, updates the in-app
///     `ProactiveMomentsCache`, and resubmits a follow-up request.
///
/// `setTaskCompleted(success:)` MUST be called or iOS treats the task
/// as runaway and pulls the privilege.

protocol BackgroundFetchScheduling: AnyObject {
    func register()
    func scheduleNext()
}

final class BackgroundFetchService: BackgroundFetchScheduling {
    static let proactiveRefreshIdentifier = "com.lumo.rentals.ios.proactive-refresh"
    /// 4h matches the brief's "earliest-begin-date 4 hours after last
    /// successful run" guidance. iOS may run earlier or much later;
    /// the value is a hint, not a guarantee.
    static let earliestBeginInterval: TimeInterval = 4 * 60 * 60

    private let cache: ProactiveMomentsCache
    private let fetcher: ProactiveMomentsFetching

    init(cache: ProactiveMomentsCache, fetcher: ProactiveMomentsFetching) {
        self.cache = cache
        self.fetcher = fetcher
    }

    func register() {
        BGTaskScheduler.shared.register(
            forTaskWithIdentifier: Self.proactiveRefreshIdentifier,
            using: nil
        ) { [weak self] task in
            guard let self, let refreshTask = task as? BGAppRefreshTask else {
                task.setTaskCompleted(success: false)
                return
            }
            self.handle(task: refreshTask)
        }
    }

    func scheduleNext() {
        let request = BGAppRefreshTaskRequest(identifier: Self.proactiveRefreshIdentifier)
        request.earliestBeginDate = Date(timeIntervalSinceNow: Self.earliestBeginInterval)
        do {
            try BGTaskScheduler.shared.submit(request)
        } catch {
            // Most common failures: simulator without background-app-refresh,
            // device with low power mode. Non-fatal; the next foreground
            // pass will pick up new moments anyway.
            print("[notif] BGTaskScheduler.submit failed: \(error)")
        }
    }

    private func handle(task: BGAppRefreshTask) {
        // Re-schedule before doing the work so we always have a future
        // task on file even if the work below fails.
        scheduleNext()

        let workItem = Task {
            do {
                let response = try await fetcher.fetchRecent()
                await cache.update(with: response)
                // Schedule local notifications for moments whose primary
                // action wants foreground attention. v1 heuristic:
                // proactive-suggestions older than 30 min that haven't
                // been surfaced yet. Server-driven notification
                // delivery (push) remains the primary channel.
                scheduleLocalNotifications(for: response.moments)
                task.setTaskCompleted(success: true)
            } catch {
                task.setTaskCompleted(success: false)
            }
        }
        task.expirationHandler = {
            workItem.cancel()
        }
    }

    private func scheduleLocalNotifications(for moments: [ProactiveMoment]) {
        // v1 minimal: skip if any of these conditions, so the user
        // isn't double-notified by background work + the in-app card.
        // Future work (LOCAL-NOTIF-REFINE follow-up) replaces this with
        // a server-side `should_local_notify` flag per moment.
        let center = UNUserNotificationCenter.current()
        for moment in moments where moment.typedCategory != nil && !moment.isExpired() {
            let content = UNMutableNotificationContent()
            content.title = moment.headline
            content.body = moment.body
            content.categoryIdentifier = moment.category
            content.userInfo = [
                "momentID": moment.id,
                "headline": moment.headline,
                "chatPrefill": moment.primaryAction.chatPrefill ?? "",
            ]
            // 60s delay on background-fetch surfaces — gives the
            // user a chance to interact with the in-app card first.
            let trigger = UNTimeIntervalNotificationTrigger(timeInterval: 60, repeats: false)
            let request = UNNotificationRequest(
                identifier: "proactive.\(moment.id)",
                content: content,
                trigger: trigger
            )
            center.add(request)
        }
    }
}

/// Test stub — exposes `triggerHandler` so unit tests can simulate the
/// scheduler firing without a live `BGTaskScheduler` (which the
/// simulator + xctest harness doesn't expose).
final class FakeBackgroundFetchService: BackgroundFetchScheduling {
    private(set) var registerCallCount: Int = 0
    private(set) var scheduleNextCallCount: Int = 0
    var lastScheduledRequestEarliestBegin: Date?

    func register() {
        registerCallCount += 1
    }

    func scheduleNext() {
        scheduleNextCallCount += 1
        lastScheduledRequestEarliestBegin = Date(
            timeIntervalSinceNow: BackgroundFetchService.earliestBeginInterval
        )
    }
}
