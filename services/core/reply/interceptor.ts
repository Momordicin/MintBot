// 回复检查 —— 拦截类（docs/MintBot_TDD.md §3.8「回复检查」拦截类）：不合格的回复不入库，
// 判错的后果是丢数据。与文本检测类分开成两个文件、两组单测，不合并成一个「检查函数」——
// 两类的作用与判错后果完全不同（TDD 原文表格），拦截类命中时调用方要做的是"整段丢弃"，
// 文本检测类命中时调用方要做的是"照常入库、额外触发一个信号"，混在一起会让两种失败模式
// 的调用方处理逻辑纠缠在同一个返回值里。

// 当前唯一判据：解析后的 reply 正文去掉首尾空白后为空。这是已知的真实入口——模型调用
// 成功但返回空字符串时，原本会照常 addMessage(sessionId, 'assistant', '')，写入的记录带
// embedded: false, summarized: false，于是一条空 assistant 消息同时进入 embedding 队列
// （为空串生成向量并写进 message_embeddings / message_fts）与摘要待处理集。命中拦截时
// 调用方（services/core/routes/chat.ts）要做的三件事（console.error / 不入库 / 发 system
// 事件）都不在本模块——本模块只做纯判定，不产生任何副作用
export function isEmptyReply(replyText: string): boolean {
  return replyText.trim().length === 0
}
