// electron/main/homeDisplayCommit.ts — 拖拽落点裁决为 accept 且带新首选显示器时、或快捷键换屏选定目标屏幕时，把它记为该窗口的用户选定主显示器
// 用法：windowBehavior.ts 的拖拽落点处理里调 commitHomeDisplayFromDragOutcome(windowKey, outcome)，快捷键换屏 movePetToNextDisplay 里调 commitHomeDisplayFromHotkey(windowKey, displayId)
// 对应文件：electron/main/windowPositions.ts（commitUserChosenHomeDisplay）/ electron/main/desktopPresence.ts（DragOutcome）/ electron/main/windowBehavior.ts / electron/main/windowPositionsCommitGuard.test.ts
import { commitUserChosenHomeDisplay } from './windowPositions'
import type { WindowKey } from './windowPositions'
import type { DragOutcome } from './desktopPresence'

export function commitHomeDisplayFromDragOutcome(windowKey: WindowKey, outcome: DragOutcome): void {
  if (outcome.kind === 'accept' && outcome.newPreferredDisplayId !== null) {
    commitUserChosenHomeDisplay(windowKey, outcome.newPreferredDisplayId)
  }
}

export function commitHomeDisplayFromHotkey(windowKey: WindowKey, displayId: number): void {
  commitUserChosenHomeDisplay(windowKey, displayId)
}
