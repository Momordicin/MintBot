import { commitUserChosenHomeDisplay } from './windowPositions'
import type { WindowKey } from './windowPositions'
import type { DragOutcome } from './desktopPresence'

// Stage 2 遗留缺口的补丁（docs/MintBot_TDD.md §3.7 附「桌面呈现状态机」"Placement" 一节，
// 该节的不变量："自动避让只修改 currentDisplayId 并置 temporaryRelocation = true，永远不
// 写入任何偏好"）。这个模块只做一件事：把「记为家」这一次写入从 windowBehavior.ts 的拖拽
// 落盘逻辑里单独抽出来，让它成为 commitUserChosenHomeDisplay（electron/main/
// windowPositions.ts）在整个代码库里唯一的合法调用方。
//
// 这样做是为了让 windowPositionsCommitGuard.test.ts 的守卫从"正则定位某个函数体内部有没有
// 调用"（脆弱——evaluatePetPresence 与真正的拖拽落盘代码可以同处一个文件，正则抓不出调用
// 在哪个函数里）升级成"哪些文件 import 了这个符号"这种 import 边界检查（稳健得多）：
// windowBehavior.ts 现在完全不 import commitUserChosenHomeDisplay，如果有人以后把这次写入
// 从拖拽路径挪进 evaluatePetPresence/evaluateChatPresence，就必须在 windowBehavior.ts 里
// 新增一条 import，这会被守卫测试直接抓到。
export function commitHomeDisplayFromDragOutcome(windowKey: WindowKey, outcome: DragOutcome): void {
  // 'reject'（合法性校验没通过）绝不能走到这里提交任何家——拖拽本身被整体拒绝了，调用方
  // 会把窗口弹回去，这次拖拽在语义上等同于没有发生
  if (outcome.kind === 'accept' && outcome.newPreferredDisplayId !== null) {
    commitUserChosenHomeDisplay(windowKey, outcome.newPreferredDisplayId)
  }
}
