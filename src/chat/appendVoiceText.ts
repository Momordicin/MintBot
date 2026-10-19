// src/chat/appendVoiceText.ts — 把语音识别文字依次拼接到输入框现有内容末尾
// 用法：ChatWindow 取到 POST /voice/take 的 texts 后调 appendVoiceText(current, texts)
// 对应文件：src/chat/ChatWindow.tsx / src/chat/InputBar.tsx / src/chat/appendVoiceText.test.ts
const ASCII_NON_WHITESPACE = /^[\x21-\x7e]$/

export function appendVoiceText(current: string, texts: string[]): string {
  let result = current
  for (const text of texts) {
    if (result.length > 0 && text.length > 0
      && ASCII_NON_WHITESPACE.test(result[result.length - 1])
      && ASCII_NON_WHITESPACE.test(text[0])) {
      result += ' '
    }
    result += text
  }
  return result
}
