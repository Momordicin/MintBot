// 注意：这个开关有意保持独立于 config/index.ts 的标准 config.json 合并逻辑之外，不是遗漏——
// 部署驱动、只读环境变量，不支持 config.json 配置或运行时热更新（见下方说明）。

// 部署驱动的加密开关（TDD §3.6）：本地部署默认明文，线上 / VPS 部署务必设为 true。
// false → 敏感字段明文落盘 + FTS 索引可用；true → AES-256-GCM 加密落盘 + FTS 不落盘（仅向量召回）。
//
// 注意：此开关仅影响新写入的数据，不支持在已有数据的 DB 上运行时翻转 ——
// 翻转不会回填加密已有明文行，也不会清除已落盘的明文 message_fts 索引。
// 翻转前必须使用全新的空 DB；已有数据库的重新加密 / FTS 重建迁移是后续独立任务，尚未实现。
export function getEncryptSensitiveFields(): boolean {
  const raw = process.env.ENCRYPT_SENSITIVE_FIELDS
  return raw === 'true' || raw === '1'
}
