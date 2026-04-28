import Foundation

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
