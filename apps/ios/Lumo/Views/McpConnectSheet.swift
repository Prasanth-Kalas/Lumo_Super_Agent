import SwiftUI

/// IOS-MCP-CONNECT-1 — token-paste sheet for connecting an MCP
/// server. Mirror of the web `McpConnectModal` modal.
///
/// Phase 1 connect model for third-party MCP servers is
/// "paste a long-lived bearer token you generated yourself."
/// It's a developer-preview pattern — fine for partners and
/// power users, blunt about its preview status in the copy.
/// MCP OAuth (`mcp_oauth`) follows once the dynamic-client-
/// registration flow ships server-side.
struct McpConnectSheet: View {
    let agent: MarketplaceAgentDTO
    @ObservedObject var viewModel: MarketplaceScreenViewModel
    var onDismiss: () -> Void

    @State private var token: String = ""
    @FocusState private var tokenFieldFocused: Bool

    private var isConnecting: Bool {
        viewModel.mcpConnectingAgentID == agent.agent_id
    }

    var body: some View {
        NavigationStack {
            Form {
                Section {
                    VStack(alignment: .leading, spacing: 4) {
                        Text("CONNECT · VIA MCP")
                            .font(LumoFonts.caption.weight(.semibold))
                            .tracking(1.4)
                            .foregroundStyle(LumoColors.labelTertiary)
                        Text(agent.display_name)
                            .font(LumoFonts.title)
                            .foregroundStyle(LumoColors.label)
                        Text(agent.one_liner)
                            .font(LumoFonts.callout)
                            .foregroundStyle(LumoColors.labelSecondary)
                            .padding(.top, 2)
                    }
                    .padding(.vertical, LumoSpacing.xs)
                }

                Section("Access token") {
                    SecureField("Paste your token", text: $token)
                        .textContentType(.password)
                        .autocorrectionDisabled(true)
                        .textInputAutocapitalization(.never)
                        .focused($tokenFieldFocused)
                        .accessibilityIdentifier("mcp.token.field")
                        .disabled(isConnecting)
                }

                if let err = viewModel.mcpConnectError {
                    Section {
                        Text(err)
                            .font(LumoFonts.caption)
                            .foregroundStyle(LumoColors.error)
                            .accessibilityIdentifier("mcp.token.error")
                    }
                }

                Section {
                    Text("Developer preview. Tokens are stored on Lumo's servers and attached to every call to \(agent.display_name). You can revoke it anytime from Connections.")
                        .font(LumoFonts.caption)
                        .foregroundStyle(LumoColors.labelTertiary)
                        .fixedSize(horizontal: false, vertical: true)
                }
            }
            .navigationTitle("Connect")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    Button("Cancel") { onDismiss() }
                        .disabled(isConnecting)
                }
                ToolbarItem(placement: .confirmationAction) {
                    Button {
                        Task {
                            let ok = await viewModel.connectMcp(agent: agent, token: token)
                            if ok { onDismiss() }
                        }
                    } label: {
                        if isConnecting {
                            ProgressView()
                        } else {
                            Text("Connect")
                                .fontWeight(.semibold)
                        }
                    }
                    .disabled(isConnecting || token.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty)
                    .accessibilityIdentifier("mcp.token.submit")
                }
            }
            .onAppear {
                // Focus shortly after present to match the web modal's
                // auto-focus behavior.
                DispatchQueue.main.asyncAfter(deadline: .now() + 0.1) {
                    tokenFieldFocused = true
                }
            }
        }
    }
}
