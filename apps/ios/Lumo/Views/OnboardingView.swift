import SwiftUI

/// IOS-ONBOARDING-1 — first-launch welcome.
///
/// Shown once per user, between sign-in and the chat shell. Mirrors
/// web's `/onboarding` flow's contract (set `extra.onboarded_at` on
/// the user_profile so subsequent launches skip the welcome) but
/// the iOS surface is intentionally minimal: a value-prop scroll
/// rather than the connector-pairing grid web ships, because iOS
/// doesn't yet have the OAuth start flow (filed under
/// IOS-MARKETPLACE-RICH-CARDS-1 follow-up). The connector grid
/// can be layered on once OAuth lands.

struct OnboardingView: View {
    @ObservedObject var viewModel: OnboardingViewModel

    init(viewModel: OnboardingViewModel) {
        self.viewModel = viewModel
    }

    var body: some View {
        VStack(spacing: 0) {
            ScrollView {
                VStack(alignment: .leading, spacing: LumoSpacing.lg) {
                    header
                    pillarsSection
                    nextStepsSection
                }
                .padding(.horizontal, LumoSpacing.lg)
                .padding(.top, LumoSpacing.xl)
                .padding(.bottom, LumoSpacing.xxl)
            }
            footer
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity)
        .background(LumoColors.background.ignoresSafeArea())
        .accessibilityIdentifier("onboarding.root")
    }

    // MARK: - Sections

    private var header: some View {
        VStack(alignment: .leading, spacing: LumoSpacing.sm) {
            Image(systemName: "sparkles")
                .font(.system(size: 36, weight: .light))
                .foregroundStyle(LumoColors.cyan)
            Text("Welcome to Lumo")
                .font(LumoFonts.largeTitle)
                .foregroundStyle(LumoColors.label)
            Text("Your AI travel and lifestyle agent. Ask in plain English; Lumo plans, books, and remembers.")
                .font(LumoFonts.body)
                .foregroundStyle(LumoColors.labelSecondary)
                .fixedSize(horizontal: false, vertical: true)
        }
    }

    private var pillarsSection: some View {
        VStack(spacing: LumoSpacing.sm) {
            OnboardingPillarRow(
                icon: "airplane",
                title: "Plan and book in one chat",
                description: "Flights, hotels, restaurants, ground transport. Lumo composes the whole trip and books it after you confirm."
            )
            OnboardingPillarRow(
                icon: "brain.head.profile",
                title: "Remembers what matters",
                description: "Your preferences, addresses, and dietary needs — saved as you chat. Edit or forget anything any time from Memory."
            )
            OnboardingPillarRow(
                icon: "waveform",
                title: "Hands-free with voice",
                description: "Tap-to-talk, live transcripts, and barge-in. Voice mode is fast enough for long replies."
            )
            OnboardingPillarRow(
                icon: "bell.badge",
                title: "Proactive moments",
                description: "Lumo nudges before flights board, when prices drop, or when a booking needs your attention."
            )
        }
    }

    private var nextStepsSection: some View {
        VStack(alignment: .leading, spacing: LumoSpacing.xs) {
            Text("WHEN YOU'RE READY")
                .font(LumoFonts.caption.weight(.semibold))
                .tracking(1.4)
                .foregroundStyle(LumoColors.labelTertiary)
            Text("Try saying \"plan a weekend trip to Vegas\" or \"order Thai for dinner\". Lumo will ask what it needs as it goes.")
                .font(LumoFonts.body)
                .foregroundStyle(LumoColors.labelSecondary)
                .fixedSize(horizontal: false, vertical: true)
            Text("Connect Gmail, Calendar, and other apps from Marketplace once you're inside. Some integrations are web-only for now.")
                .font(LumoFonts.caption)
                .foregroundStyle(LumoColors.labelTertiary)
                .fixedSize(horizontal: false, vertical: true)
                .padding(.top, LumoSpacing.xs)
        }
        .padding(LumoSpacing.md)
        .background(
            RoundedRectangle(cornerRadius: LumoRadius.md).fill(LumoColors.surface)
        )
        .overlay(
            RoundedRectangle(cornerRadius: LumoRadius.md)
                .stroke(LumoColors.separator, lineWidth: 1)
        )
    }

    private var footer: some View {
        VStack(spacing: 0) {
            Divider().background(LumoColors.separator)
            Button {
                Task { await viewModel.finish(via: "continue") }
            } label: {
                HStack(spacing: LumoSpacing.xs) {
                    if viewModel.isFinishing {
                        ProgressView()
                            .controlSize(.small)
                            .tint(LumoColors.background)
                    }
                    Text("Get started")
                        .font(LumoFonts.bodyEmphasized)
                }
                .frame(maxWidth: .infinity)
                .frame(height: 52)
                .foregroundStyle(LumoColors.background)
                .background(Capsule().fill(LumoColors.cyan))
            }
            .disabled(viewModel.isFinishing)
            .accessibilityIdentifier("onboarding.continue")
            .padding(.horizontal, LumoSpacing.lg)
            .padding(.top, LumoSpacing.md)
            .padding(.bottom, LumoSpacing.sm)

            Button {
                Task { await viewModel.finish(via: "skip") }
            } label: {
                Text("Skip for now")
                    .font(LumoFonts.callout.weight(.medium))
                    .foregroundStyle(LumoColors.labelSecondary)
                    .padding(.vertical, LumoSpacing.xs)
            }
            .disabled(viewModel.isFinishing)
            .accessibilityIdentifier("onboarding.skip")
            .padding(.bottom, LumoSpacing.lg)
        }
        .background(LumoColors.background)
    }
}

private struct OnboardingPillarRow: View {
    let icon: String
    let title: String
    let description: String

    var body: some View {
        HStack(alignment: .top, spacing: LumoSpacing.md) {
            ZStack {
                RoundedRectangle(cornerRadius: LumoRadius.sm)
                    .fill(LumoColors.cyan.opacity(0.12))
                    .frame(width: 44, height: 44)
                Image(systemName: icon)
                    .font(.system(size: 20, weight: .semibold))
                    .foregroundStyle(LumoColors.cyan)
            }
            VStack(alignment: .leading, spacing: 2) {
                Text(title)
                    .font(LumoFonts.bodyEmphasized)
                    .foregroundStyle(LumoColors.label)
                Text(description)
                    .font(LumoFonts.callout)
                    .foregroundStyle(LumoColors.labelSecondary)
                    .fixedSize(horizontal: false, vertical: true)
            }
            Spacer(minLength: 0)
        }
        .padding(LumoSpacing.md)
        .background(
            RoundedRectangle(cornerRadius: LumoRadius.md).fill(LumoColors.surface)
        )
        .overlay(
            RoundedRectangle(cornerRadius: LumoRadius.md)
                .stroke(LumoColors.separator, lineWidth: 1)
        )
    }
}
