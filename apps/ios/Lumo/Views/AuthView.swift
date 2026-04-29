import AuthenticationServices
import SwiftUI

/// First-launch sign-in screen. Apple Sign-In is the only production
/// path; the `#if DEBUG` "Continue without signing in" bypass below
/// exists so simulator iteration and screenshot capture don't require
/// iCloud account setup. The bypass is removed by the compiler in
/// Release builds.

struct AuthView: View {
    @ObservedObject var viewModel: AuthViewModel
    @Environment(\.colorScheme) private var colorScheme

    var body: some View {
        VStack(spacing: 0) {
            Spacer(minLength: LumoSpacing.xxxl)
            heroSection
            Spacer(minLength: LumoSpacing.xxl)
            buttonsSection
            footerSection
        }
        .padding(.horizontal, LumoSpacing.xl)
        .padding(.bottom, LumoSpacing.xxl)
        .frame(maxWidth: .infinity, maxHeight: .infinity)
        .background(LumoColors.background.ignoresSafeArea())
        .alert("Sign-in failed", isPresented: errorBinding) {
            Button("OK") { viewModel.clearError() }
        } message: {
            Text(viewModel.error ?? "")
        }
    }

    // MARK: - Hero

    private var heroSection: some View {
        VStack(spacing: LumoSpacing.lg) {
            ZStack {
                Circle()
                    .fill(LumoColors.cyan.opacity(0.15))
                    .frame(width: 96, height: 96)
                Image(systemName: "sparkles")
                    .font(.system(size: 44, weight: .semibold))
                    .foregroundStyle(LumoColors.cyan)
            }

            Text("Welcome to Lumo")
                .font(LumoFonts.largeTitle)
                .foregroundStyle(LumoColors.label)
                .multilineTextAlignment(.center)

            Text("Plan trips, find restaurants, and book everything in one conversation.")
                .font(LumoFonts.body)
                .foregroundStyle(LumoColors.labelSecondary)
                .multilineTextAlignment(.center)
                .padding(.horizontal, LumoSpacing.lg)
        }
    }

    // MARK: - Buttons

    private var buttonsSection: some View {
        VStack(spacing: LumoSpacing.md) {
            SignInWithAppleButton(.continue) { request in
                request.requestedScopes = [.fullName, .email]
                request.nonce = viewModel.makeAppleNonce()
            } onCompletion: { result in
                viewModel.handleAppleCompletion(result: result)
            }
            .signInWithAppleButtonStyle(colorScheme == .dark ? .white : .black)
            .frame(height: 50)
            .clipShape(RoundedRectangle(cornerRadius: LumoRadius.md))
            .accessibilityIdentifier("auth.signInWithApple")

            #if DEBUG
            Button {
                viewModel.devSignIn()
            } label: {
                Text("Continue without signing in (dev)")
                    .font(LumoFonts.callout)
                    .foregroundStyle(LumoColors.labelSecondary)
                    .frame(maxWidth: .infinity, minHeight: 44)
                    .overlay(
                        RoundedRectangle(cornerRadius: LumoRadius.md)
                            .stroke(LumoColors.separator, lineWidth: 1)
                    )
            }
            .accessibilityIdentifier("auth.devSignIn")
            #endif
        }
    }

    // MARK: - Footer

    private var footerSection: some View {
        VStack(spacing: LumoSpacing.xs) {
            Text("By continuing, you agree to Lumo's terms of service and privacy policy.")
                .font(LumoFonts.caption)
                .foregroundStyle(LumoColors.labelTertiary)
                .multilineTextAlignment(.center)
        }
        .padding(.top, LumoSpacing.xl)
    }

    private var errorBinding: Binding<Bool> {
        Binding(
            get: { viewModel.error != nil },
            set: { if !$0 { viewModel.clearError() } }
        )
    }
}
