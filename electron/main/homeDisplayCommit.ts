import { commitUserChosenHomeDisplay } from './windowPositions'
import type { WindowKey } from './windowPositions'
import type { DragOutcome } from './desktopPresence'

export function commitHomeDisplayFromDragOutcome(windowKey: WindowKey, outcome: DragOutcome): void {
  if (outcome.kind === 'accept' && outcome.newPreferredDisplayId !== null) {
    commitUserChosenHomeDisplay(windowKey, outcome.newPreferredDisplayId)
  }
}
