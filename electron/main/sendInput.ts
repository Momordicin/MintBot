// electron/main/sendInput.ts — Windows SendInput 封装：经 koffi 调 user32 把键盘事件序列注入当前前台窗口
// 用法：index.ts 把 sendKeyInputs 作为 createTextOutput 的 sendInput
// 对应文件：electron/main/textOutput.ts / electron/main/sendInput.test.ts
import koffi from 'koffi'
import type { KeyInput } from './textOutput'

const INPUT_KEYBOARD = 1

const user32 = process.platform === 'win32' ? koffi.load('user32.dll') : null

const MOUSEINPUT = user32
  ? koffi.struct('MintBotMouseInput', {
      dx: 'int32_t',
      dy: 'int32_t',
      mouseData: 'uint32_t',
      dwFlags: 'uint32_t',
      time: 'uint32_t',
      dwExtraInfo: 'uintptr_t',
    })
  : null
const KEYBDINPUT = user32
  ? koffi.struct('MintBotKeybdInput', {
      wVk: 'uint16_t',
      wScan: 'uint16_t',
      dwFlags: 'uint32_t',
      time: 'uint32_t',
      dwExtraInfo: 'uintptr_t',
    })
  : null
const INPUT_UNION = MOUSEINPUT && KEYBDINPUT ? koffi.union('MintBotInputUnion', { mi: MOUSEINPUT, ki: KEYBDINPUT }) : null
const INPUT = INPUT_UNION ? koffi.struct('MintBotInput', { type: 'uint32_t', u: INPUT_UNION }) : null

const SendInput = user32 && INPUT
  ? user32.func('uint32_t __stdcall SendInput(uint32_t cInputs, MintBotInput *pInputs, int cbSize)')
  : null

export const INPUT_STRUCT_SIZE = INPUT ? koffi.sizeof(INPUT) : 0

export function toNativeInputs(inputs: KeyInput[]): Array<{ type: number; u: { ki: { wVk: number; wScan: number; dwFlags: number; time: number; dwExtraInfo: number } } }> {
  return inputs.map(({ vk, scan, flags }) => ({
    type: INPUT_KEYBOARD,
    u: { ki: { wVk: vk, wScan: scan, dwFlags: flags, time: 0, dwExtraInfo: 0 } },
  }))
}

export function sendKeyInputs(inputs: KeyInput[]): void {
  if (!SendInput || inputs.length === 0) return
  const sent = SendInput(inputs.length, toNativeInputs(inputs), INPUT_STRUCT_SIZE)
  if (sent !== inputs.length) {
    console.error(`[TextOutput] SendInput injected ${sent} of ${inputs.length} events (blocked by an elevated window or UIPI)`)
  }
}
