// 建议索引（写 SQLite schema 时建立）：
// CREATE INDEX idx_messages_session ON Messages(sessionId, createdAt)
// CREATE INDEX idx_messages_visible ON Messages(sessionId, visibleToUser)
export {};
