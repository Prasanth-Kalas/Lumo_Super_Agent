import SwiftUI

/// Outlined text field with focus state and optional left/right accessory
/// content (icons, send buttons, etc.). Built atop SwiftUI's TextField so
/// keyboard, secure entry, and accessibility behaviors come for free.

struct LumoTextField<Leading: View, Trailing: View>: View {
    @Binding var text: String
    let placeholder: String
    var isSecure: Bool = false
    var submitLabel: SubmitLabel = .return
    var onSubmit: (() -> Void)?
    @ViewBuilder var leading: () -> Leading
    @ViewBuilder var trailing: () -> Trailing

    @FocusState private var isFocused: Bool

    var body: some View {
        HStack(spacing: LumoSpacing.sm) {
            leading()
            Group {
                if isSecure {
                    SecureField(placeholder, text: $text)
                } else {
                    TextField(placeholder, text: $text)
                }
            }
            .focused($isFocused)
            .submitLabel(submitLabel)
            .onSubmit { onSubmit?() }
            .font(LumoFonts.body)
            trailing()
        }
        .padding(.horizontal, LumoSpacing.md)
        .padding(.vertical, LumoSpacing.md)
        .background(
            RoundedRectangle(cornerRadius: LumoRadius.md)
                .fill(LumoColors.surface)
        )
        .overlay(
            RoundedRectangle(cornerRadius: LumoRadius.md)
                .stroke(isFocused ? LumoColors.cyan : LumoColors.separator, lineWidth: isFocused ? 1.5 : 1)
        )
        .animation(LumoAnimation.quick, value: isFocused)
    }
}

extension LumoTextField where Leading == EmptyView, Trailing == EmptyView {
    init(
        _ placeholder: String,
        text: Binding<String>,
        isSecure: Bool = false,
        submitLabel: SubmitLabel = .return,
        onSubmit: (() -> Void)? = nil
    ) {
        self.placeholder = placeholder
        self._text = text
        self.isSecure = isSecure
        self.submitLabel = submitLabel
        self.onSubmit = onSubmit
        self.leading = { EmptyView() }
        self.trailing = { EmptyView() }
    }
}

extension LumoTextField where Leading == EmptyView {
    init(
        _ placeholder: String,
        text: Binding<String>,
        isSecure: Bool = false,
        submitLabel: SubmitLabel = .return,
        onSubmit: (() -> Void)? = nil,
        @ViewBuilder trailing: @escaping () -> Trailing
    ) {
        self.placeholder = placeholder
        self._text = text
        self.isSecure = isSecure
        self.submitLabel = submitLabel
        self.onSubmit = onSubmit
        self.leading = { EmptyView() }
        self.trailing = trailing
    }
}
