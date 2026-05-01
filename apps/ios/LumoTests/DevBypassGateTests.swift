import XCTest
@testable import Lumo

/// Pins the App-Store-readiness contract for the dev-bypass button on
/// `AuthView`:
///
///   1. The button's compile-in symbol is true under the Debug config
///      (which is what `xcodebuild test` uses) and the gate constant
///      is defined via the same `#if DEBUG` directive that wraps the
///      button itself, so the symbol and the runtime presence travel
///      together.
///
///   2. A Release-config build does NOT compile the button in. We
///      can't directly run the test suite under Release to prove
///      this, so we re-implement the source-grep invariant from
///      `scripts/verify-release-bypass-stripped.sh` in Swift: the
///      button label string only appears inside `#if DEBUG / #endif`
///      blocks across `apps/ios/Lumo/**/*.swift`.
///
///   3. The Release config in `apps/ios/project.yml` does not set
///      `SWIFT_ACTIVE_COMPILATION_CONDITIONS: DEBUG`.
///
/// If a future change drops the `#if DEBUG` wrap by accident, (1) is
/// unaffected (the gate constant is still true under Debug) but (2)
/// catches the leak.
final class DevBypassGateTests: XCTestCase {

    private static let bypassLabel = "Continue without signing in"

    func test_devBypassGate_isCompiledInUnderDebug() {
        // Tests run under the Debug config (apps/ios/project.yml
        // schemes.Lumo.test.config = Debug). The constant must reflect
        // that — if it doesn't, either the gate symbol is wired wrong
        // or the test target is being built without DEBUG, which is
        // itself a misconfiguration we want to catch.
        XCTAssertTrue(
            AuthView.isDevBypassButtonCompiledIn,
            "Dev-bypass button gate symbol should be true under Debug; check #if DEBUG wrap"
        )
    }

    func test_releaseBuild_stripsDevBypass_perSourceInvariant() throws {
        let repoRoot = try requireRepoRoot()
        let lumoDir = URL(fileURLWithPath: repoRoot)
            .appendingPathComponent("apps/ios/Lumo")

        let leaks = try findBypassLabelLeaks(under: lumoDir)
        XCTAssertTrue(
            leaks.isEmpty,
            "Dev-bypass label found OUTSIDE #if DEBUG block — would leak into Release builds:\n"
                + leaks.joined(separator: "\n")
        )
    }

    func test_releaseConfig_doesNotSetDebugCompilationCondition() throws {
        let repoRoot = try requireRepoRoot()
        let projectYML = URL(fileURLWithPath: repoRoot)
            .appendingPathComponent("apps/ios/project.yml")
        let yaml = try String(contentsOf: projectYML, encoding: .utf8)
        let leaks = findReleaseConfigDebugLeaks(in: yaml)
        XCTAssertTrue(
            leaks.isEmpty,
            "Release config sets SWIFT_ACTIVE_COMPILATION_CONDITIONS to DEBUG — would compile the bypass into App Store binaries:\n"
                + leaks.joined(separator: "\n")
        )
    }

    // MARK: - Helpers

    /// Walks up from the test source file's compile-time path
    /// (`#filePath` is `apps/ios/LumoTests/DevBypassGateTests.swift`)
    /// until it finds the repo root marker. The compile-time path is
    /// baked into the binary so this works even when the test bundle
    /// runs inside the simulator sandbox.
    private func requireRepoRoot(file: String = #filePath) throws -> String {
        var url = URL(fileURLWithPath: file)
        for _ in 0..<25 {
            let marker = url.appendingPathComponent("apps/ios/Lumo/Views/AuthView.swift")
            if FileManager.default.fileExists(atPath: marker.path) {
                return url.path
            }
            let parent = url.deletingLastPathComponent()
            if parent.path == url.path { break }
            url = parent
        }
        throw XCTSkip("Could not locate repo root from \(file); test bundle outside repo")
    }

    /// Walks every `*.swift` file under `dir` and returns
    /// `path:line: text` strings for any occurrence of the bypass
    /// label that is NOT inside an `#if DEBUG / #endif` block.
    /// Comments (lines starting with `//` or `///` after optional
    /// leading whitespace) are ignored — the compiler strips them, so
    /// the bypass string appearing in a doc comment doesn't matter.
    private func findBypassLabelLeaks(under dir: URL) throws -> [String] {
        let enumerator = FileManager.default.enumerator(
            at: dir,
            includingPropertiesForKeys: [.isRegularFileKey],
            options: [.skipsHiddenFiles]
        )
        var leaks: [String] = []
        while let url = enumerator?.nextObject() as? URL {
            guard url.pathExtension == "swift" else { continue }
            let contents = (try? String(contentsOf: url, encoding: .utf8)) ?? ""
            guard contents.contains(Self.bypassLabel) else { continue }

            var depth = 0
            for (index, line) in contents.split(separator: "\n", omittingEmptySubsequences: false).enumerated() {
                let trimmed = line.trimmingCharacters(in: .whitespaces)
                if trimmed.hasPrefix("#if DEBUG") {
                    depth += 1
                    continue
                }
                if trimmed.hasPrefix("#endif") {
                    if depth > 0 { depth -= 1 }
                    continue
                }
                if trimmed.hasPrefix("//") {
                    continue
                }
                if depth == 0 && line.contains(Self.bypassLabel) {
                    leaks.append("\(url.path):\(index + 1): \(line)")
                }
            }
        }
        return leaks
    }

    /// Looks at `project.yml` text and returns offending lines if the
    /// `Release:` config under any target's `configs:` block sets
    /// `SWIFT_ACTIVE_COMPILATION_CONDITIONS` to `DEBUG`. Indentation-
    /// sensitive: a sibling key (same indent as `Release:`) ends the
    /// scan, mirroring the awk in
    /// `scripts/verify-release-bypass-stripped.sh`.
    private func findReleaseConfigDebugLeaks(in yaml: String) -> [String] {
        var leaks: [String] = []
        var inConfigs = false
        var inRelease = false
        var releaseIndent = -1
        let lines = yaml.split(separator: "\n", omittingEmptySubsequences: false)
        for (index, raw) in lines.enumerated() {
            let line = String(raw)
            let firstNonSpace = line.firstIndex(where: { !$0.isWhitespace })
            let indent: Int
            if let first = firstNonSpace {
                indent = line.distance(from: line.startIndex, to: first)
            } else {
                indent = -1
            }
            let trimmed = line.trimmingCharacters(in: .whitespaces)

            if trimmed == "configs:" {
                inConfigs = true
                continue
            }
            if inConfigs && trimmed == "Release:" {
                inRelease = true
                releaseIndent = indent
                continue
            }
            if inRelease {
                if trimmed.hasPrefix("SWIFT_ACTIVE_COMPILATION_CONDITIONS:") && trimmed.contains("DEBUG") {
                    leaks.append("project.yml:\(index + 1): \(trimmed)")
                    inRelease = false
                    continue
                }
                if indent >= 0 && indent <= releaseIndent && trimmed.hasSuffix(":") {
                    inRelease = false
                }
            }
        }
        return leaks
    }
}
