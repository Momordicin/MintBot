// services/core/reply/interceptor.ts — 判断模型回复正文是否为空（trim 后长度为 0）
// 用法：isEmptyReply(replyText) 返回 boolean；POST /chat 解出 replyText 后调用，为空则向 SSE 发 system 错误事件、不入库
// 对应文件：services/core/routes/chat.ts / services/core/reply/interceptor.test.ts

export function isEmptyReply(replyText: string): boolean {
  return replyText.trim().length === 0
}
