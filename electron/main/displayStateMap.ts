import type { ExternalWindowInfo } from './activeWindowMonitor'

export type Reason = 'fullscreen' | 'user-rule'
export type Severity = 'soft' | 'hard'

export type AppRuleEffect = 'allow' | 'soft' | 'hard'

export interface AppRule {
  exeName: string
  effect: AppRuleEffect
}

export type DisplayBlocker = {
  hwnd: bigint
  pid: number
  exeName: string | null
  displayId: number
  reasons: Set<Reason>
  severity: Severity
}

export type DisplayStateMap = Map<number, DisplayBlocker>

export type BlockingRules = {
  appRules: AppRule[]
}

function findRule(rules: BlockingRules, exeName: string): AppRule | undefined {
  const lower = exeName.toLowerCase()
  return rules.appRules.find(rule => rule.exeName.toLowerCase() === lower)
}

const SHELL_UI_EXE = 'explorer.exe'
const SHELL_UI_CLASSES = new Set([
  'XamlExplorerHostIslandWindow',
  'MultitaskingViewFrame',
  'ForegroundStaging',
  'TaskSwitcherWnd',
])

export function isShellUiWindow(info: Pick<ExternalWindowInfo, 'exeName' | 'className'>): boolean {
  return info.exeName !== null && info.exeName.toLowerCase() === SHELL_UI_EXE && SHELL_UI_CLASSES.has(info.className)
}

function classify(
  exeName: string | null,
  isFullscreen: boolean,
  rules: BlockingRules
): { reasons: Set<Reason>; severity: Severity } {
  const rule = exeName !== null ? findRule(rules, exeName) : undefined
  if (rule?.effect === 'allow') return { reasons: new Set(), severity: 'soft' }

  const reasons = new Set<Reason>()
  let severity: Severity = 'soft'
  if (isFullscreen) {
    reasons.add('fullscreen')
    severity = 'hard'
  }
  if (rule) {
    reasons.add('user-rule')
    if (rule.effect === 'hard') severity = 'hard'
  }
  return { reasons, severity }
}

export function classifyBlockingReasons(info: ExternalWindowInfo, rules: BlockingRules): Set<Reason> {
  return classify(info.exeName, info.isFullscreen, rules).reasons
}

export function applyExternalObservation(
  map: DisplayStateMap,
  info: ExternalWindowInfo,
  rules: BlockingRules
): DisplayStateMap {
  if (info.pid === null) return map
  if (isShellUiWindow(info)) return map

  const { reasons, severity } = classify(info.exeName, info.isFullscreen, rules)
  if (reasons.size === 0) return map

  const next = new Map(map)
  next.set(info.displayId, {
    hwnd: info.hwnd,
    pid: info.pid,
    exeName: info.exeName,
    displayId: info.displayId,
    reasons,
    severity,
  })
  return next
}

export type BlockerProbe =
  | { status: 'gone' }
  | { status: 'pid-mismatch' }
  | { status: 'hidden' }
  | { status: 'probe-error' }
  | { status: 'ok'; displayId: number; isFullscreen: boolean }

export type ValidationMode = 'standard' | 'conservative'

export function decideBlockerAfterValidation(
  blocker: DisplayBlocker,
  probe: BlockerProbe,
  rules: BlockingRules,
  mode: ValidationMode = 'standard'
): DisplayBlocker | null {
  if (probe.status === 'gone' || probe.status === 'pid-mismatch' || probe.status === 'hidden') return null

  if (probe.status === 'probe-error') return blocker

  if (mode === 'conservative' && probe.status === 'ok') {
    return { ...blocker, displayId: probe.displayId }
  }

  const { reasons, severity } = classify(blocker.exeName, probe.isFullscreen, rules)
  if (reasons.size === 0) return null

  return { ...blocker, displayId: probe.displayId, reasons, severity }
}

const SEVERITY_RANK: Record<Severity, number> = { soft: 0, hard: 1 }

export function pickPrecedentBlocker(a: DisplayBlocker, b: DisplayBlocker): DisplayBlocker {
  if (SEVERITY_RANK[a.severity] !== SEVERITY_RANK[b.severity]) {
    return SEVERITY_RANK[a.severity] > SEVERITY_RANK[b.severity] ? a : b
  }
  if (a.reasons.size !== b.reasons.size) {
    return a.reasons.size > b.reasons.size ? a : b
  }
  return a.pid <= b.pid ? a : b
}

export function validateBlockers(
  map: DisplayStateMap,
  rules: BlockingRules,
  probe: (hwnd: bigint, pid: number) => BlockerProbe,
  mode: ValidationMode = 'standard'
): DisplayStateMap {
  const next: DisplayStateMap = new Map()
  for (const blocker of map.values()) {
    const decided = decideBlockerAfterValidation(blocker, probe(blocker.hwnd, blocker.pid), rules, mode)
    if (decided === null) continue
    const collidingWith = next.get(decided.displayId)
    next.set(decided.displayId, collidingWith ? pickPrecedentBlocker(collidingWith, decided) : decided)
  }
  return next
}
