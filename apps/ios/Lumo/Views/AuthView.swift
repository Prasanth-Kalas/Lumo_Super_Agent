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

            Button {
                viewModel.startGoogleSignIn()
            } label: {
                HStack(spacing: LumoSpacing.sm) {
                    GoogleGlyph()
                    Text("Continue with Google")
                        .font(LumoFonts.bodyEmphasized)
                }
                .frame(maxWidth: .infinity, minHeight: 50)
                .overlay(
                    RoundedRectangle(cornerRadius: LumoRadius.md)
                        .stroke(LumoColors.separator, lineWidth: 1)
                )
            }
            .foregroundStyle(LumoColors.label)
            .accessibilityIdentifier("auth.signInWithGoogle")

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

    /// Inline Google "G" mark — drawn rather than referenced as an
    /// asset so we don't ship a Google-branded image. Geometry matches
    /// the standard quartered logo per Google's brand guidelines and
    /// sits right alongside the SwiftUI `SignInWithAppleButton` glyph.
    private struct GoogleGlyph: View {
        var body: some View {
            ZStack {
                Path { p in
                    p.addEllipse(in: CGRect(x: 0, y: 0, width: 18, height: 18))
                }
                .fill(Color.white)
                Text("G")
                    .font(.system(size: 13, weight: .bold, design: .default))
                    .foregroundStyle(
                        LinearGradient(
                            colors: [
                                Color(red: 0.26, green: 0.52, blue: 0.96),
                                Color(red: 0.92, green: 0.26, blue: 0.21),
                            ],
                            startPoint: .topLeading,
                            endPoint: .bottomTrailing
                        )
                    )
            }
            .frame(width: 18, height: 18)
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
