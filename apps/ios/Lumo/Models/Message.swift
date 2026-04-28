import Foundation

/// A single message exchanged in the chat. `Message` is the canonical
/// type used by the orchestrator (text + role), `ChatMessage` extends it
/// with UI-only state (lifecycle status) for the message-list view.

struct Message: Identifiable, Hashable {
    enum Role: String {
        case user
        case assistant
    }

    let id: UUID
    let role: Role
    var text: String
    let createdAt: Date

    init(id: UUID = UUID(), role: Role, text: String, createdAt: Date = .now) {
        self.id = id
        self.role = role
        self.text = text
        self.createdAt = createdAt
    }
}

enum MessageStatus: String, Equatable {
    case sending      // user message: POST in flight
    case sent         // user message: server accepted, waiting for stream
    case streaming    // assistant message: tokens arriving
    case delivered    // assistant message: stream completed cleanly
    case failed       // either side: terminal error, can be retried
}

struct ChatMessage: Identifiable, Hashable {
    let id: UUID
    let role: Message.Role
    var text: String
    let createdAt: Date
    var status: MessageStatus

    init(
        id: UUID = UUID(),
        role: Message.Role,
        text: String,
        createdAt: Date = .now,
        status: MessageStatus
    ) {
        self.id = id
        self.role = role
        self.text = text
        self.createdAt = createdAt
        self.status = status
    }
}

struct ChatRequestMessage: Encodable {
    let role: String
    let content: String
}

struct ChatRequest: Encodable {
    let session_id: String
    let messages: [ChatRequestMessage]
    let device_kind: String
    let region: String?
}
