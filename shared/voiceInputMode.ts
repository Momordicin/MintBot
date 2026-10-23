// shared/voiceInputMode.ts — 语音输入模式（关闭 / 聆听 / 转写）的取值、校验与聊天窗口语音按钮的循环顺序
// 用法：services/core 的配置层与 voice 路由用 isVoiceInputMode 校验；Electron 主进程托盘与聊天窗口 InputBar 用 VoiceInputMode / nextVoiceInputMode
// 对应文件：services/core/config/index.ts / services/core/voice/agent.ts / services/core/voice/routes.ts / electron/main/index.ts / src/chat/ChatWindow.tsx / shared/voiceInputMode.test.ts
export const VOICE_INPUT_MODES = ['off', 'listen', 'transcribe'] as const

export type VoiceInputMode = typeof VOICE_INPUT_MODES[number]

export function isVoiceInputMode(value: unknown): value is VoiceInputMode {
  return typeof value === 'string' && (VOICE_INPUT_MODES as readonly string[]).includes(value)
}

export function nextVoiceInputMode(mode: VoiceInputMode): VoiceInputMode {
  return VOICE_INPUT_MODES[(VOICE_INPUT_MODES.indexOf(mode) + 1) % VOICE_INPUT_MODES.length]
}
