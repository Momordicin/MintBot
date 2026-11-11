// src/settings/useCharacterPanel.ts — 设置窗口角色相关页面（角色 / 外观 / 人设与模型）共用的状态与操作
// 用法：SettingsApp 调用 useCharacterPanel({ presetSnapshot, onSwitched })，把返回值传给 CharacterPanel / AppearancePanel / PersonaModelPanel，并用其中的 presets / switchPreset 渲染左栏角色下拉框；GET /presets、/presets/:id/model-keys、/config/model、/characters、/characters/:id/manifest.json，POST /switch-preset、/presets、/presets/:id/wallpaper、/characters/import/{parse,generate}、/characters/:id/{avatar,metadata}，PATCH /presets/:id，DELETE /presets/:id，POST /presets/:id/role-config/lookup、/presets/:id/role-config/confirm、/presets/:id/role-config/synthesize、/presets/:id/role-config/finish，GET /presets/:id/role-config/status，POST /voice/test/start、/voice/test/stop、/voice/enroll/start、/voice/enroll/commit、/voice/enroll/cancel、/voice/enroll/dismiss-interrupted，GET /voice/status、/events（voice-status-changed）；electronAPI.selectWallpaperFile / selectCharacterCardFile / sendGreeting
// 对应文件：src/settings/SettingsApp.tsx / src/settings/CharacterPanel.tsx / src/settings/VoiceEnrollProgress.tsx / src/settings/AppearancePanel.tsx / src/settings/PersonaModelPanel.tsx / src/errorText.ts / src/settings/themeControls.ts / src/chat/theme.ts / src/chat/themeVars.ts / src/chat/sse.ts / src/eventsWatchdog.ts / shared/portraitForm.ts / services/core/index.ts / services/core/routes/presets.ts / services/core/routes/characterImport.ts / services/core/routes/roleConfig.ts / electron/main/index.ts（select-wallpaper-file、select-character-card-file、chat:greet）
import { useCallback, useEffect, useMemo, useRef, useState, type ChangeEvent } from 'react'
import { useTranslation } from 'react-i18next'
import type { AppState, ModelConfig, PresetDisplayConfig, PresetSnapshot } from '../../shared/types/index.js'
import { hexToRgb, percentToTintStrength } from './themeControls.js'
import { deriveTheme } from '../chat/theme.js'
import { resolveThemeMode, themeCssVars } from '../chat/themeVars.js'
import { usePrefersDark } from '../usePrefersDark.js'
import { parseSSE } from '../chat/sse.js'
import { createWatchdogEventSource } from '../eventsWatchdog.js'
import { isErrorBody } from '../../shared/errorCodes.js'
import { errorText } from '../errorText.js'
import type { ApiKeySummary, KeyProvider } from './ApiKeyField.js'
import type { EnrollSentence, EnrollSpeaker } from './VoiceEnrollProgress.js'
import { isPortraitFormAvailable, resolveEffectiveForm, type PortraitFormName, type PortraitFormShape } from '../../shared/portraitForm.js'

import { CORE_URL } from '../coreUrl.js'
const DEFAULT_WALLPAPER_URL = `${CORE_URL}/wallpapers/bg.jpg`
const DEFAULT_DISPLAY_CONFIG: PresetDisplayConfig = {
  chatBgRgb: [15, 15, 20],
  chatBgOpacity: 0.65,
  themeMode: 'auto',
  accentRgb: [0, 122, 255],
  tintStrength: 0,
  currentPortrait: 'pixel',
  petScale: { pixel: 1, illustration: 1 },
}
const DISPLAY_CONFIG_DEBOUNCE_MS = 400

export interface PresetOption {
  presetId: string
  name: string
}

type SystemPromptStep = 'idle' | 'editing' | 'confirmingSave' | 'confirmingApply' | 'saving'

type ModelOverrideStep = 'idle' | 'editing' | 'chooseApply' | 'saving'

type RoleConfigStatus = 'idle' | 'looking' | 'choosing' | 'naming' | 'saving' | 'collecting' | 'reading' | 'finishing' | 'saved' | 'error' | 'failed'

type RoleConfigStep = 'extract' | 'search' | 'merge' | 'plugin' | 'synthesize' | 'analyze' | 'write'
type RoleConfigPluginKind = 'check' | 'install' | 'update'

type RoleConfigReadChoice = 'pending' | 'confirmingSkip' | 'enter'

type RoleConfigStepState = 'start' | 'done' | 'failed'

interface RoleConfigName {
  name: string
  selected: boolean
}

interface RoleConfigReading {
  name: string
  script: string
}

interface RoleConfigSample extends RoleConfigReading {
  transcript: string
}

interface VoiceTestResultText {
  kind: string
  text?: string
  textRaw?: string
}

interface RoleConfigVoice {
  phase: string | null
  mode: string
  speaker: EnrollSpeaker | null
  enroll: { completed: EnrollSentence[]; current: EnrollSentence[] }
  enrollInterrupted: boolean
}

interface RoleConfigReadState {
  readings: RoleConfigReading[]
  transcripts: (string | null)[]
  target: number | null
  seen: number
  testActive: boolean
}

const ROLE_CONFIG_READ_TIMEOUT_MS = 30000

interface RoleConfigCandidate {
  main_name: string
  aliases: { name: string; pages: number[] }[]
  source_summary: string
  relation: string | null
  pages: number[]
}

type RoleConfigLookup =
  | { kind: 'candidates'; candidates: RoleConfigCandidate[]; personaMainName: string; personaNames: string[] }
  | { kind: 'names'; mainName: string | null; names: string[]; failed: boolean }

function cleanNames(raw: string[]): string[] {
  const seen = new Set<string>()
  for (const item of raw) {
    const name = item.trim()
    if (name !== '') seen.add(name)
  }
  return [...seen]
}

function addRoleConfigNames(prev: RoleConfigName[], added: string[]): RoleConfigName[] {
  const known = new Set(prev.map(item => item.name))
  const marked = prev.map(item => (added.includes(item.name) ? { ...item, selected: true } : item))
  return [...marked, ...added.filter(name => !known.has(name)).map(name => ({ name, selected: true }))]
}

function currentReadingIndex(read: RoleConfigReadState): number {
  return read.target ?? read.transcripts.indexOf(null)
}

function roleConfigChoice(lookup: RoleConfigLookup, selected: number | 'none' | null): { mainName: string | null; names: string[] } {
  if (lookup.kind === 'names') return { mainName: lookup.mainName, names: lookup.names }
  if (typeof selected === 'number') {
    const candidate = lookup.candidates[selected]
    return { mainName: candidate.main_name, names: [candidate.main_name, ...candidate.aliases.map(alias => alias.name)] }
  }
  return { mainName: lookup.personaMainName, names: lookup.personaNames }
}

type ModelKeyState = ApiKeySummary & { fromEnv: boolean }

type ModelKeySummaries = Record<KeyProvider, ModelKeyState & { summary: ModelKeyState }>

const BLANK_MODEL_KEY: ModelKeyState = { hasKey: false, last4: null, fromEnv: false }
type KeyLoadStatus = 'loading' | 'ready' | 'error'

const NO_ENV_DETECTED: Record<KeyProvider, boolean> = { anthropic: false, openai: false, deepseek: false }

interface UseCharacterPanelArgs {
  presetSnapshot: PresetSnapshot | null
  onSwitched: (state: AppState) => void
}

export function useCharacterPanel({ presetSnapshot, onSwitched }: UseCharacterPanelArgs) {
  const { i18n } = useTranslation()
  const [presets, setPresets] = useState<PresetOption[]>([])
  const [characterIds, setCharacterIds] = useState<string[]>([])
  const [isUploadingWallpaper, setIsUploadingWallpaper] = useState(false)
  const [switchError, setSwitchError] = useState<string | null>(null)
  const [characterError, setCharacterErrorState] = useState<string | null>(null)
  const [appearanceError, setAppearanceErrorState] = useState<string | null>(null)
  const [personaError, setPersonaErrorState] = useState<string | null>(null)
  const setCharacterError = useCallback((message: string | null) => {
    setCharacterErrorState(message)
    if (message === null) setSwitchError(null)
  }, [])
  const setAppearanceError = useCallback((message: string | null) => {
    setAppearanceErrorState(message)
    if (message === null) setSwitchError(null)
  }, [])
  const setPersonaError = useCallback((message: string | null) => {
    setPersonaErrorState(message)
    if (message === null) setSwitchError(null)
  }, [])
  const [isRenaming, setIsRenaming] = useState(false)
  const [renameValue, setRenameValue] = useState('')
  const [isSavingRename, setIsSavingRename] = useState(false)
  const [renameInputWidth, setRenameInputWidth] = useState<number | null>(null)
  const presetNameRef = useRef<HTMLSpanElement | null>(null)
  const renameInputRef = useRef<HTMLInputElement | null>(null)
  const [deleteTarget, setDeleteTarget] = useState<{ presetId: string; name: string } | null>(null)
  const [isDeleting, setIsDeleting] = useState(false)
  const [isSwitchingPreset, setIsSwitchingPreset] = useState(false)
  const [isCreating, setIsCreating] = useState(false)
  const [createName, setCreateName] = useState('')
  const [createCharacterId, setCreateCharacterId] = useState('')
  const [createSystemPrompt, setCreateSystemPrompt] = useState('')
  const [isSavingCreate, setIsSavingCreate] = useState(false)
  const [isImportingCard, setIsImportingCard] = useState(false)
  const [isGeneratingSystemPrompt, setIsGeneratingSystemPrompt] = useState(false)
  const [importedCardFields, setImportedCardFields] = useState<{
    description: string
    personality: string
    scenario: string
    mesExample: string
    systemPromptRaw: string
  } | null>(null)
  const [importedAvatarFile, setImportedAvatarFile] = useState<{ data: Uint8Array<ArrayBuffer>; filename: string } | null>(null)
  const [importedMetadataFields, setImportedMetadataFields] = useState<{
    tags: string[]
    creator: string
    creatorNotes: string
    characterVersion: string
  } | null>(null)
  const [systemPromptStep, setSystemPromptStep] = useState<SystemPromptStep>('idle')
  const [systemPromptValue, setSystemPromptValue] = useState('')
  const [systemPromptNotice, setSystemPromptNotice] = useState<string | null>(null)
  const [modelOverrideStep, setModelOverrideStep] = useState<ModelOverrideStep>('idle')
  const [useGlobalModel, setUseGlobalModel] = useState(true)
  const [overrideModelType, setOverrideModelType] = useState<ModelConfig['type']>('anthropic')
  const [overrideModelName, setOverrideModelName] = useState('')
  const [overrideKeyInput, setOverrideKeyInput] = useState('')
  const [overrideKeyEditing, setOverrideKeyEditing] = useState(false)
  const [overrideFromEnvChoice, setOverrideFromEnvChoice] = useState<boolean | null>(null)
  const [summarySameAsChat, setSummarySameAsChat] = useState(true)
  const [summaryModelType, setSummaryModelType] = useState<ModelConfig['type']>('anthropic')
  const [summaryModelName, setSummaryModelName] = useState('')
  const [summaryKeyInput, setSummaryKeyInput] = useState('')
  const [summaryKeyEditing, setSummaryKeyEditing] = useState(false)
  const [summaryFromEnvChoice, setSummaryFromEnvChoice] = useState<boolean | null>(null)
  const [modelKeys, setModelKeys] = useState<ModelKeySummaries | null>(null)
  const [envDetected, setEnvDetected] = useState<Record<KeyProvider, boolean>>(NO_ENV_DETECTED)
  const [modelKeysStatus, setModelKeysStatus] = useState<KeyLoadStatus>('loading')
  const [envStatus, setEnvStatus] = useState<KeyLoadStatus>('loading')
  const [modelOverrideNotice, setModelOverrideNotice] = useState<string | null>(null)
  const [roleConfigStatus, setRoleConfigStatus] = useState<RoleConfigStatus>('idle')
  const [roleConfigLookup, setRoleConfigLookup] = useState<RoleConfigLookup | null>(null)
  const [roleConfigSelected, setRoleConfigSelected] = useState<number | 'none' | null>(null)
  const [roleConfigSteps, setRoleConfigSteps] = useState<Partial<Record<RoleConfigStep, RoleConfigStepState>>>({})
  const [roleConfigMainName, setRoleConfigMainName] = useState<string | null>(null)
  const [roleConfigNames, setRoleConfigNames] = useState<RoleConfigName[]>([])
  const [roleConfigInput, setRoleConfigInput] = useState('')
  const [roleConfigSaved, setRoleConfigSaved] = useState('')
  const [roleConfigGreetName, setRoleConfigGreetName] = useState('')
  const [roleConfigPluginKind, setRoleConfigPluginKind] = useState<RoleConfigPluginKind>('check')
  const [roleConfigVoiceDone, setRoleConfigVoiceDone] = useState(false)
  const [roleConfigReadChoice, setRoleConfigReadChoice] = useState<RoleConfigReadChoice>('pending')
  const [roleConfigError, setRoleConfigError] = useState<string | null>(null)
  const [roleConfigComplete, setRoleConfigComplete] = useState<boolean | null>(null)
  const [roleConfigCompleteFailed, setRoleConfigCompleteFailed] = useState(false)
  const [roleConfigReadInterrupted, setRoleConfigReadInterrupted] = useState(false)
  const [roleConfigReadStarting, setRoleConfigReadStarting] = useState(false)
  const [roleConfigReadings, setRoleConfigReadings] = useState<RoleConfigReading[]>([])
  const [roleConfigTranscripts, setRoleConfigTranscripts] = useState<(string | null)[]>([])
  const [roleConfigCurrent, setRoleConfigCurrent] = useState(-1)
  const [roleConfigSynthReady, setRoleConfigSynthReady] = useState(false)
  const [roleConfigEnrollAsk, setRoleConfigEnrollAsk] = useState(false)
  const [roleConfigEnrolling, setRoleConfigEnrolling] = useState(false)
  const [roleConfigEnrollBusy, setRoleConfigEnrollBusy] = useState(false)
  const [roleConfigEnrollInterrupted, setRoleConfigEnrollInterrupted] = useState(false)
  const [roleConfigEnrollError, setRoleConfigEnrollError] = useState<string | null>(null)
  const [roleConfigVoice, setRoleConfigVoice] = useState<RoleConfigVoice | null>(null)
  const switchPresetControllerRef = useRef<AbortController | null>(null)
  const wallpaperControllerRef = useRef<AbortController | null>(null)
  const renameControllerRef = useRef<AbortController | null>(null)
  const createControllerRef = useRef<AbortController | null>(null)
  const deleteControllerRef = useRef<AbortController | null>(null)
  const importControllerRef = useRef<AbortController | null>(null)
  const generateControllerRef = useRef<AbortController | null>(null)
  const avatarUploadControllerRef = useRef<AbortController | null>(null)
  const metadataMergeControllerRef = useRef<AbortController | null>(null)
  const systemPromptControllerRef = useRef<AbortController | null>(null)
  const modelOverrideControllerRef = useRef<AbortController | null>(null)
  const modelKeysControllerRef = useRef<AbortController | null>(null)
  const envControllerRef = useRef<AbortController | null>(null)
  const roleConfigControllerRef = useRef<AbortController | null>(null)
  const roleConfigStatusControllerRef = useRef<AbortController | null>(null)
  const roleConfigReadRef = useRef<RoleConfigReadState>({ readings: [], transcripts: [], target: null, seen: 0, testActive: false })
  const roleConfigSamplesRef = useRef<RoleConfigSample[]>([])
  const roleConfigReadTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const roleConfigReadStartingRef = useRef(false)
  const roleConfigTestStartCountRef = useRef(0)
  const roleConfigFinishingRef = useRef(false)
  const roleConfigEnteringRef = useRef(false)
  const roleConfigEnrollSentRef = useRef(false)
  const roleConfigEnrollingRef = useRef(false)
  const roleConfigVoiceSeqRef = useRef(0)
  const roleConfigEnrollControllerRef = useRef<AbortController | null>(null)
  const roleConfigEnrollInterruptedRef = useRef(false)
  const presetSnapshotRef = useRef<PresetSnapshot | null>(presetSnapshot)
  const [chatBgOpacity, setChatBgOpacity] = useState<number>(DEFAULT_DISPLAY_CONFIG.chatBgOpacity)
  const [themeMode, setThemeMode] = useState<PresetDisplayConfig['themeMode']>(DEFAULT_DISPLAY_CONFIG.themeMode)
  const [accentRgb, setAccentRgb] = useState<[number, number, number]>(DEFAULT_DISPLAY_CONFIG.accentRgb)
  const [tintStrength, setTintStrength] = useState<number>(DEFAULT_DISPLAY_CONFIG.tintStrength)
  const [portraitForms, setPortraitForms] = useState<Partial<Record<PortraitFormName, PortraitFormShape>> | null>(null)
  const [isSwitchingPortrait, setIsSwitchingPortrait] = useState(false)
  const displayConfigControllerRef = useRef<AbortController | null>(null)
  const displayConfigDebounceRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const pendingDisplayConfigRef = useRef<{ presetId: string; partial: Partial<PresetDisplayConfig> } | null>(null)

  const prefersDark = usePrefersDark()
  const previewResolvedMode = resolveThemeMode(themeMode, prefersDark)
  const previewTheme = useMemo(
    () => deriveTheme({ accentRgb, mode: previewResolvedMode, tintStrength }),
    [accentRgb, previewResolvedMode, tintStrength]
  )
  const previewVars = useMemo(
    () => themeCssVars(previewTheme, chatBgOpacity),
    [previewTheme, chatBgOpacity]
  )
  const previewWallpaperUrl = presetSnapshot?.wallpaperPath
    ? `${CORE_URL}/wallpapers/${encodeURIComponent(presetSnapshot.wallpaperPath)}`
    : DEFAULT_WALLPAPER_URL

  useEffect(() => {
    presetSnapshotRef.current = presetSnapshot
  }, [presetSnapshot])

  useEffect(() => {
    if (isDeleting) return
    if (deleteTarget && deleteTarget.presetId !== presetSnapshot?.presetId) setDeleteTarget(null)
  }, [presetSnapshot?.presetId, deleteTarget, isDeleting])

  useEffect(() => {
    setChatBgOpacity(presetSnapshot?.displayConfig?.chatBgOpacity ?? DEFAULT_DISPLAY_CONFIG.chatBgOpacity)
    setThemeMode(presetSnapshot?.displayConfig?.themeMode ?? DEFAULT_DISPLAY_CONFIG.themeMode)
    setAccentRgb(presetSnapshot?.displayConfig?.accentRgb ?? DEFAULT_DISPLAY_CONFIG.accentRgb)
    setTintStrength(presetSnapshot?.displayConfig?.tintStrength ?? DEFAULT_DISPLAY_CONFIG.tintStrength)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [presetSnapshot?.presetId])

  const characterId = presetSnapshot?.characterId
  useEffect(() => {
    setPortraitForms(null)
    if (!characterId) return
    const controller = new AbortController()
    fetch(`${CORE_URL}/characters/${encodeURIComponent(characterId)}/manifest.json`, { signal: controller.signal })
      .then(r => {
        if (!r.ok) throw new Error(`HTTP ${r.status}`)
        return r.json()
      })
      .then((manifest: { portraits?: Partial<Record<PortraitFormName, PortraitFormShape>> }) => {
        if (controller.signal.aborted) return
        setPortraitForms(manifest.portraits ?? {})
      })
      .catch((err: unknown) => {
        if (err instanceof DOMException && err.name === 'AbortError') return
        console.error('[CharacterPanel] 读取角色 manifest 失败', characterId, err)
      })
    return () => controller.abort()
  }, [characterId])

  useEffect(() => {
    setSystemPromptStep('idle')
    setSystemPromptValue(presetSnapshot?.systemPrompt ?? '')
    setSystemPromptNotice(null)
    setModelOverrideStep('idle')
    setUseGlobalModel(presetSnapshot?.modelType === null)
    setOverrideModelType(presetSnapshot?.modelType ?? 'anthropic')
    setOverrideModelName(presetSnapshot?.modelName ?? '')
    setOverrideKeyInput('')
    setOverrideKeyEditing(false)
    setOverrideFromEnvChoice(null)
    setSummarySameAsChat((presetSnapshot?.summaryModelType ?? null) === null)
    setSummaryModelType(presetSnapshot?.summaryModelType ?? 'anthropic')
    setSummaryModelName(presetSnapshot?.summaryModelName ?? '')
    setSummaryKeyInput('')
    setSummaryKeyEditing(false)
    setSummaryFromEnvChoice(null)
    modelKeysControllerRef.current?.abort()
    setModelKeys(null)
    setModelKeysStatus('loading')
    setModelOverrideNotice(null)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [presetSnapshot?.presetId])

  const stopRoleConfigTest = useCallback((keepalive = false) => {
    const read = roleConfigReadRef.current
    if (!read.testActive) return
    read.testActive = false
    fetch(`${CORE_URL}/voice/test/stop`, { method: 'POST', keepalive }).catch(() => {
    })
  }, [])

  const stopRoleConfigEnroll = useCallback((keepalive = false) => {
    if (!roleConfigEnrollSentRef.current) return
    roleConfigEnrollSentRef.current = false
    roleConfigEnrollingRef.current = false
    fetch(`${CORE_URL}/voice/enroll/cancel`, { method: 'POST', keepalive }).catch(() => {
    })
  }, [])

  const resetRoleConfigEnroll = useCallback(() => {
    roleConfigEnrollControllerRef.current?.abort()
    roleConfigEnrollControllerRef.current = null
    stopRoleConfigEnroll()
    roleConfigVoiceSeqRef.current++
    setRoleConfigSynthReady(false)
    setRoleConfigEnrollAsk(false)
    setRoleConfigEnrolling(false)
    setRoleConfigEnrollBusy(false)
    setRoleConfigEnrollInterrupted(false)
    setRoleConfigEnrollError(null)
    setRoleConfigVoice(null)
  }, [stopRoleConfigEnroll])

  const loadRoleConfigVoice = useCallback(() => {
    const mine = ++roleConfigVoiceSeqRef.current
    fetch(`${CORE_URL}/voice/status`)
      .then(r => {
        if (!r.ok) throw new Error(`HTTP ${r.status}`)
        return r.json()
      })
      .then((body: RoleConfigVoice) => {
        if (mine !== roleConfigVoiceSeqRef.current) return
        if (roleConfigEnrollingRef.current && body.mode === 'normal') {
          roleConfigEnrollSentRef.current = false
          roleConfigEnrollingRef.current = false
          setRoleConfigEnrolling(false)
          if (body.enrollInterrupted) {
            setRoleConfigEnrollInterrupted(true)
            setRoleConfigVoice({
              phase: body.phase,
              mode: body.mode,
              speaker: body.speaker,
              enroll: body.enroll,
              enrollInterrupted: body.enrollInterrupted,
            })
            fetch(`${CORE_URL}/voice/enroll/dismiss-interrupted`, { method: 'POST' }).catch(() => {})
            return
          }
          setRoleConfigEnrollAsk(false)
          setRoleConfigVoice(null)
          return
        }
        setRoleConfigVoice({
          phase: body.phase,
          mode: body.mode,
          speaker: body.speaker,
          enroll: body.enroll,
          enrollInterrupted: body.enrollInterrupted,
        })
      })
      .catch((err: unknown) => {
        console.error('[CharacterPanel] 读取语音状态失败', err)
      })
  }, [])

  const clearRoleConfigReadTimer = useCallback(() => {
    if (roleConfigReadTimerRef.current === null) return
    clearTimeout(roleConfigReadTimerRef.current)
    roleConfigReadTimerRef.current = null
  }, [])

  const armRoleConfigReadTimer = useCallback(() => {
    clearRoleConfigReadTimer()
    roleConfigReadTimerRef.current = setTimeout(() => {
      roleConfigReadTimerRef.current = null
      stopRoleConfigTest()
      setRoleConfigReadInterrupted(true)
    }, ROLE_CONFIG_READ_TIMEOUT_MS)
  }, [clearRoleConfigReadTimer, stopRoleConfigTest])

  const loadRoleConfigComplete = useCallback((presetId: string) => {
    roleConfigStatusControllerRef.current?.abort()
    const controller = new AbortController()
    roleConfigStatusControllerRef.current = controller
    setRoleConfigComplete(null)
    setRoleConfigCompleteFailed(false)
    fetch(`${CORE_URL}/presets/${encodeURIComponent(presetId)}/role-config/status`, { signal: controller.signal })
      .then(r => {
        if (!r.ok) throw new Error(`HTTP ${r.status}`)
        return r.json()
      })
      .then((body: { complete: boolean }) => {
        if (controller.signal.aborted) return
        setRoleConfigComplete(body.complete)
      })
      .catch((err: unknown) => {
        if (err instanceof DOMException && err.name === 'AbortError') return
        console.error('[CharacterPanel] 读取角色配置完成状态失败', presetId, err)
        if (!controller.signal.aborted) setRoleConfigCompleteFailed(true)
      })
  }, [])

  useEffect(() => {
    roleConfigControllerRef.current?.abort()
    clearRoleConfigReadTimer()
    stopRoleConfigTest()
    resetRoleConfigEnroll()
    setRoleConfigStatus('idle')
    setRoleConfigLookup(null)
    setRoleConfigSelected(null)
    setRoleConfigSteps({})
    setRoleConfigMainName(null)
    setRoleConfigNames([])
    setRoleConfigInput('')
    setRoleConfigSaved('')
    setRoleConfigGreetName('')
    setRoleConfigPluginKind('check')
    setRoleConfigVoiceDone(false)
    setRoleConfigReadChoice('pending')
    setRoleConfigError(null)
    setRoleConfigReadings([])
    setRoleConfigTranscripts([])
    setRoleConfigCurrent(-1)
    setRoleConfigReadInterrupted(false)
    setRoleConfigComplete(null)
    setRoleConfigCompleteFailed(false)
    if (presetSnapshot?.presetId) loadRoleConfigComplete(presetSnapshot.presetId)
  }, [presetSnapshot?.presetId])

  useEffect(() => {
    roleConfigEnrollInterruptedRef.current = roleConfigEnrollInterrupted
  }, [roleConfigEnrollInterrupted])

  useEffect(() => {
    const onPageHide = () => {
      clearRoleConfigReadTimer()
      stopRoleConfigTest(true)
      stopRoleConfigEnroll(true)
    }
    window.addEventListener('pagehide', onPageHide)
    return () => window.removeEventListener('pagehide', onPageHide)
  }, [clearRoleConfigReadTimer, stopRoleConfigTest, stopRoleConfigEnroll])

  useEffect(() => {
    return () => {
      switchPresetControllerRef.current?.abort()
      wallpaperControllerRef.current?.abort()
      renameControllerRef.current?.abort()
      createControllerRef.current?.abort()
      deleteControllerRef.current?.abort()
      displayConfigControllerRef.current?.abort()
      systemPromptControllerRef.current?.abort()
      modelOverrideControllerRef.current?.abort()
      modelKeysControllerRef.current?.abort()
      envControllerRef.current?.abort()
      roleConfigControllerRef.current?.abort()
      roleConfigStatusControllerRef.current?.abort()
      roleConfigEnrollControllerRef.current?.abort()
      clearRoleConfigReadTimer()
      stopRoleConfigTest(true)
      stopRoleConfigEnroll(true)
      importControllerRef.current?.abort()
      generateControllerRef.current?.abort()
      avatarUploadControllerRef.current?.abort()
      metadataMergeControllerRef.current?.abort()

      if (displayConfigDebounceRef.current) {
        clearTimeout(displayConfigDebounceRef.current)
        displayConfigDebounceRef.current = null
      }
      const pending = pendingDisplayConfigRef.current
      pendingDisplayConfigRef.current = null
      if (pending) {
        fetch(`${CORE_URL}/presets/${encodeURIComponent(pending.presetId)}`, {
          method: 'PATCH',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ displayConfig: pending.partial }),
        }).catch(() => {
        })
      }
    }
  }, [])

  useEffect(() => {
    fetch(`${CORE_URL}/presets`)
      .then(r => r.json())
      .then((list: PresetOption[]) => setPresets(list))
      .catch(() => {
      })
  }, [])

  useEffect(() => {
    fetch(`${CORE_URL}/characters`)
      .then(r => {
        if (!r.ok) throw new Error(`HTTP ${r.status}`)
        return r.json()
      })
      .then((body: { characterIds: string[] }) => setCharacterIds(body.characterIds))
      .catch(() => {
        setCharacterError(i18n.t('角色文件夹列表加载失败，无法创建新角色，请检查核心服务后重试'))
      })
  }, [])

  const loadModelKeys = useCallback((presetId: string) => {
    modelKeysControllerRef.current?.abort()
    const controller = new AbortController()
    modelKeysControllerRef.current = controller
    setModelKeysStatus('loading')

    fetch(`${CORE_URL}/presets/${encodeURIComponent(presetId)}/model-keys`, { signal: controller.signal })
      .then(r => {
        if (!r.ok) throw new Error(`HTTP ${r.status}`)
        return r.json()
      })
      .then((keys: ModelKeySummaries) => {
        if (controller.signal.aborted) return
        setModelKeys(keys)
        setModelKeysStatus('ready')
      })
      .catch((err: unknown) => {
        if (err instanceof DOMException && err.name === 'AbortError') return
        console.error('[PersonaModelPanel] 读取角色 API Key 状态失败', presetId, err)
        setModelKeysStatus('error')
      })
  }, [])

  const loadEnvDetected = useCallback(() => {
    envControllerRef.current?.abort()
    const controller = new AbortController()
    envControllerRef.current = controller
    setEnvStatus('loading')

    fetch(`${CORE_URL}/config/model`, { signal: controller.signal })
      .then(r => {
        if (!r.ok) throw new Error(`HTTP ${r.status}`)
        return r.json()
      })
      .then((config: { modelProvider: { keys: Record<KeyProvider, { envDetected: boolean }> } | null }) => {
        if (controller.signal.aborted) return
        const detected = config.modelProvider?.keys
        setEnvDetected(detected
          ? { anthropic: detected.anthropic.envDetected, openai: detected.openai.envDetected, deepseek: detected.deepseek.envDetected }
          : NO_ENV_DETECTED)
        setEnvStatus('ready')
      })
      .catch((err: unknown) => {
        if (err instanceof DOMException && err.name === 'AbortError') return
        console.error('[PersonaModelPanel] 读取环境变量检测状态失败', err)
        setEnvStatus('error')
      })
  }, [])

  const retryModelKeys = useCallback(() => {
    const presetId = presetSnapshotRef.current?.presetId
    if (presetId) loadModelKeys(presetId)
  }, [loadModelKeys])

  const switchPreset = useCallback(async (presetId: string) => {
    switchPresetControllerRef.current?.abort()
    wallpaperControllerRef.current?.abort()
    const controller = new AbortController()
    switchPresetControllerRef.current = controller
    setIsSwitchingPreset(true)
    setSwitchError(null)
    setCharacterError(null)
    setAppearanceError(null)
    setPersonaError(null)

    try {
      const response = await fetch(`${CORE_URL}/switch-preset`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ presetId }),
        signal: controller.signal,
      })

      if (!response.ok) {
        throw new Error(`HTTP ${response.status}`)
      }

      const state: AppState = await response.json()
      if (controller.signal.aborted) return

      onSwitched(state)
    } catch (err) {
      if (!(err instanceof DOMException && err.name === 'AbortError')) {
        setSwitchError(i18n.t('切换角色失败，请稍后重试'))
      }
    } finally {
      if (switchPresetControllerRef.current === controller && !controller.signal.aborted) {
        setIsSwitchingPreset(false)
      }
    }
  }, [onSwitched])

  const handleWallpaperPick = useCallback(async () => {
    const presetId = presetSnapshotRef.current?.presetId
    if (!presetId) return
    if (isUploadingWallpaper) return

    setIsUploadingWallpaper(true)
    setAppearanceError(null)
    try {
      const result = await window.electronAPI.selectWallpaperFile()
      if (!result) return

      if (presetSnapshotRef.current?.presetId !== presetId) return

      wallpaperControllerRef.current?.abort()
      const controller = new AbortController()
      wallpaperControllerRef.current = controller

      const response = await fetch(`${CORE_URL}/presets/${encodeURIComponent(presetId)}/wallpaper`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/octet-stream',
          'X-Filename': encodeURIComponent(result.filename),
        },
        body: result.data,
        signal: controller.signal,
      })

      if (!response.ok) {
        throw new Error(`HTTP ${response.status}`)
      }

      const state: AppState = await response.json()
      if (controller.signal.aborted) return

      onSwitched(state)
    } catch (err) {
      if (err instanceof DOMException && err.name === 'AbortError') return
      if (err instanceof Error && err.message.includes('file-too-large')) {
        setAppearanceError(i18n.t('图片文件过大，请选择小于 10MB 的图片'))
        return
      }
      setAppearanceError(i18n.t('更换壁纸失败，请稍后重试'))
    } finally {
      setIsUploadingWallpaper(false)
    }
  }, [isUploadingWallpaper, onSwitched])

  const handleRenameStart = useCallback(() => {
    const nameWidth = presetNameRef.current?.offsetWidth
    setRenameInputWidth(nameWidth ? nameWidth : null)
    setRenameValue(presetSnapshotRef.current?.name ?? '')
    setCharacterError(null)
    setIsRenaming(true)
  }, [])

  useEffect(() => {
    if (!isRenaming) return
    renameInputRef.current?.focus()
    renameInputRef.current?.select()
  }, [isRenaming])

  useEffect(() => {
    if (isRenaming && !isSavingRename) renameInputRef.current?.focus()
  }, [isRenaming, isSavingRename])

  const handleRenameCancel = useCallback(() => {
    setIsRenaming(false)
    setCharacterError(null)
  }, [])

  const handleRenameSave = useCallback(async () => {
    const presetId = presetSnapshotRef.current?.presetId
    if (!presetId) return

    const trimmedName = renameValue.trim()
    if (!trimmedName) {
      setCharacterError(i18n.t('名称不能为空'))
      return
    }

    renameControllerRef.current?.abort()
    const controller = new AbortController()
    renameControllerRef.current = controller
    setIsSavingRename(true)
    setCharacterError(null)

    try {
      const response = await fetch(`${CORE_URL}/presets/${encodeURIComponent(presetId)}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: trimmedName }),
        signal: controller.signal,
      })

      if (!response.ok) {
        throw new Error(`HTTP ${response.status}`)
      }

      const state: AppState = await response.json()
      if (controller.signal.aborted) return

      if (state.presetSnapshot?.presetId === presetSnapshotRef.current?.presetId) {
        onSwitched(state)
      }
      setPresets(prev => prev.map(p => (p.presetId === presetId ? { ...p, name: trimmedName } : p)))
      setIsRenaming(false)
    } catch (err) {
      if (err instanceof DOMException && err.name === 'AbortError') return
      setCharacterError(i18n.t('重命名失败，请稍后重试'))
    } finally {
      setIsSavingRename(false)
    }
  }, [renameValue, onSwitched])

  const handleDeleteStart = useCallback(() => {
    const current = presetSnapshotRef.current
    if (!current) return
    setCharacterError(null)
    setDeleteTarget({ presetId: current.presetId, name: current.name })
  }, [])

  const handleDeleteCancel = useCallback(() => {
    setDeleteTarget(null)
  }, [])

  const handleDeleteConfirm = useCallback(async () => {
    if (!deleteTarget) return
    const presetId = deleteTarget.presetId

    if (pendingDisplayConfigRef.current?.presetId === presetId) {
      if (displayConfigDebounceRef.current) {
        clearTimeout(displayConfigDebounceRef.current)
        displayConfigDebounceRef.current = null
      }
      pendingDisplayConfigRef.current = null
    }

    deleteControllerRef.current?.abort()
    const controller = new AbortController()
    deleteControllerRef.current = controller
    setIsDeleting(true)
    setCharacterError(null)

    try {
      const response = await fetch(`${CORE_URL}/presets/${encodeURIComponent(presetId)}`, {
        method: 'DELETE',
        signal: controller.signal,
      })

      if (response.status === 409) {
        setCharacterError(i18n.t('至少需要保留一个角色'))
        return
      }
      if (!response.ok) {
        throw new Error(`HTTP ${response.status}`)
      }

      const state: AppState = await response.json()
      if (controller.signal.aborted) return

      onSwitched(state)
      setPresets(prev => prev.filter(p => p.presetId !== presetId))
    } catch (err) {
      if (err instanceof DOMException && err.name === 'AbortError') return
      setCharacterError(i18n.t('删除失败，请稍后重试'))
    } finally {
      if (deleteControllerRef.current === controller && !controller.signal.aborted) {
        setIsDeleting(false)
        setDeleteTarget(null)
      }
    }
  }, [deleteTarget, onSwitched])

  const handleCreateStart = useCallback(() => {
    setCreateName('')
    setCreateCharacterId(characterIds[0] ?? '')
    setCreateSystemPrompt('')
    setImportedCardFields(null)
    setImportedAvatarFile(null)
    setImportedMetadataFields(null)
    setCharacterError(null)
    setIsCreating(true)
  }, [characterIds])

  const handleCreateCancel = useCallback(() => {
    setIsCreating(false)
    setImportedCardFields(null)
    setImportedAvatarFile(null)
    setImportedMetadataFields(null)
    setCharacterError(null)
  }, [])

  const handleImportCardPick = useCallback(async () => {
    if (isImportingCard) return

    setIsImportingCard(true)
    setCharacterError(null)
    try {
      const result = await window.electronAPI.selectCharacterCardFile()
      if (!result) return

      importControllerRef.current?.abort()
      const controller = new AbortController()
      importControllerRef.current = controller

      const response = await fetch(`${CORE_URL}/characters/import/parse`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/octet-stream',
          'X-Filename': encodeURIComponent(result.filename),
        },
        body: result.data,
        signal: controller.signal,
      })

      if (!response.ok) {
        const body = await response.json().catch(() => null)
        throw new Error(isErrorBody(body) ? errorText(body, i18n.t) : `HTTP ${response.status}`)
      }

      const parsed = await response.json()
      if (controller.signal.aborted) return

      setCreateName(parsed.name)
      setCreateCharacterId(parsed.suggestedCharacterId)
      setCreateSystemPrompt(parsed.systemPrompt)
      setImportedCardFields({
        description: parsed.description,
        personality: parsed.personality,
        scenario: parsed.scenario,
        mesExample: parsed.mesExample,
        systemPromptRaw: parsed.systemPromptRaw,
      })
      setImportedAvatarFile(parsed.hasEmbeddedAvatar ? result : null)
      setImportedMetadataFields({
        tags: parsed.tags,
        creator: parsed.creator,
        creatorNotes: parsed.creatorNotes,
        characterVersion: parsed.characterVersion,
      })
      setIsCreating(true)
    } catch (err) {
      if (err instanceof DOMException && err.name === 'AbortError') return
      if (err instanceof Error && err.message.includes('file-too-large')) {
        setCharacterError(i18n.t('角色卡文件过大，请选择小于 5MB 的文件'))
        return
      }
      setCharacterError(err instanceof Error && err.message ? err.message : i18n.t('导入角色卡失败，请稍后重试'))
    } finally {
      setIsImportingCard(false)
    }
  }, [isImportingCard])

  const handleRegenerateSystemPrompt = useCallback(async () => {
    if (!importedCardFields || isGeneratingSystemPrompt) return

    generateControllerRef.current?.abort()
    const controller = new AbortController()
    generateControllerRef.current = controller
    setIsGeneratingSystemPrompt(true)
    setCharacterError(null)

    try {
      const response = await fetch(`${CORE_URL}/characters/import/generate`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(importedCardFields),
        signal: controller.signal,
      })

      if (!response.ok) {
        throw new Error(`HTTP ${response.status}`)
      }

      const { systemPrompt }: { systemPrompt: string } = await response.json()
      if (controller.signal.aborted) return

      setCreateSystemPrompt(systemPrompt)
    } catch (err) {
      if (err instanceof DOMException && err.name === 'AbortError') return
      setCharacterError(i18n.t('模型辅助改写失败，请稍后重试'))
    } finally {
      setIsGeneratingSystemPrompt(false)
    }
  }, [importedCardFields, isGeneratingSystemPrompt])

  const handleCreateSave = useCallback(async () => {
    const trimmedName = createName.trim()
    const trimmedCharacterId = createCharacterId.trim()
    const trimmedSystemPrompt = createSystemPrompt.trim()
    if (!trimmedName) {
      setCharacterError(i18n.t('名称不能为空'))
      return
    }
    if (!trimmedCharacterId) {
      setCharacterError(i18n.t('角色包 ID 不能为空'))
      return
    }
    if (!trimmedSystemPrompt) {
      setCharacterError(i18n.t('人设内容不能为空'))
      return
    }

    createControllerRef.current?.abort()
    const controller = new AbortController()
    createControllerRef.current = controller
    setIsSavingCreate(true)
    setCharacterError(null)

    try {
      const response = await fetch(`${CORE_URL}/presets`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: trimmedName, characterId: trimmedCharacterId, systemPrompt: trimmedSystemPrompt }),
        signal: controller.signal,
      })

      if (!response.ok) {
        throw new Error(`HTTP ${response.status}`)
      }

      const { presetId, name }: { presetId: string; name: string } = await response.json()
      if (controller.signal.aborted) return

      setPresets(prev => [...prev, { presetId, name }])
      setIsCreating(false)

      if (importedAvatarFile) {
        avatarUploadControllerRef.current?.abort()
        const avatarController = new AbortController()
        avatarUploadControllerRef.current = avatarController
        fetch(`${CORE_URL}/characters/${encodeURIComponent(trimmedCharacterId)}/avatar`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/octet-stream',
            'X-Filename': encodeURIComponent(importedAvatarFile.filename),
          },
          body: importedAvatarFile.data,
          signal: avatarController.signal,
        }).catch(() => {
        })
      }
      if (importedMetadataFields) {
        metadataMergeControllerRef.current?.abort()
        const metadataController = new AbortController()
        metadataMergeControllerRef.current = metadataController
        fetch(`${CORE_URL}/characters/${encodeURIComponent(trimmedCharacterId)}/metadata`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(importedMetadataFields),
          signal: metadataController.signal,
        }).catch(() => {
        })
      }
      setImportedCardFields(null)
      setImportedAvatarFile(null)
      setImportedMetadataFields(null)

      void switchPreset(presetId)
    } catch (err) {
      if (err instanceof DOMException && err.name === 'AbortError') return
      setCharacterError(i18n.t('创建角色失败，请稍后重试'))
    } finally {
      setIsSavingCreate(false)
    }
  }, [createName, createCharacterId, createSystemPrompt, importedAvatarFile, importedMetadataFields, switchPreset])

  const streamRoleConfig = useCallback(async <T>(path: string, body: unknown, controller: AbortController): Promise<T | null> => {
    const response = await fetch(`${CORE_URL}${path}`, {
      method: 'POST',
      headers: body === undefined ? undefined : { 'Content-Type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: controller.signal,
    })
    if (!response.ok) {
      const payload = await response.json().catch(() => null)
      throw new Error(isErrorBody(payload) ? errorText(payload, i18n.t) : i18n.t('角色部分配置自动生成失败，详情见日志'))
    }

    let result: T | null = null
    for await (const { event, data } of parseSSE(response)) {
      if (controller.signal.aborted) return null
      if (event === 'step') {
        const { step, state, update } = data as { step: Exclude<RoleConfigStep, 'plugin'> | 'check' | 'install'; state: RoleConfigStepState; update?: boolean }
        const key: RoleConfigStep = step === 'check' || step === 'install' ? 'plugin' : step
        setRoleConfigSteps(prev => ({ ...prev, [key]: state }))
        if (step === 'install') setRoleConfigPluginKind(update === true ? 'update' : 'install')
        if (step === 'install' && state === 'done' && update !== true) {
          roleConfigEnrollControllerRef.current = new AbortController()
          setRoleConfigEnrollAsk(true)
        }
      } else if (event === 'result') {
        result = data as T
      }
    }
    return result
  }, [])

  const syncRoleConfigReading = useCallback(() => {
    const read = roleConfigReadRef.current
    setRoleConfigTranscripts([...read.transcripts])
    setRoleConfigCurrent(currentReadingIndex(read))
  }, [])

  const startRoleConfigTest = useCallback(async (controller: AbortController): Promise<boolean> => {
    roleConfigReadStartingRef.current = true
    setRoleConfigReadStarting(true)
    try {
      const response = await fetch(`${CORE_URL}/voice/test/start`, { method: 'POST' }).catch(() => null)
      if (!response || !response.ok) {
        console.error('[CharacterPanel] 启动朗读测试失败', response?.status)
        return false
      }
      const read = roleConfigReadRef.current
      read.testActive = true
      read.seen = 0
      roleConfigTestStartCountRef.current++
      if (controller.signal.aborted) {
        stopRoleConfigTest()
        return false
      }
      setRoleConfigReadInterrupted(false)
      armRoleConfigReadTimer()
      return true
    } finally {
      roleConfigReadStartingRef.current = false
      setRoleConfigReadStarting(false)
    }
  }, [stopRoleConfigTest, armRoleConfigReadTimer])

  const markRoleConfigFailedSteps = useCallback((scope: RoleConfigStep[]) => {
    setRoleConfigSteps(prev => {
      const next = { ...prev }
      for (const key of Object.keys(next) as RoleConfigStep[]) {
        if (next[key] === 'start') next[key] = 'failed'
      }
      if (!scope.some(step => next[step] === 'failed')) {
        const target = scope.find(step => next[step] !== 'done') ?? scope[scope.length - 1]
        next[target] = 'failed'
      }
      return next
    })
  }, [])

  const failRoleConfig = useCallback((err: unknown, scope: RoleConfigStep[]) => {
    setRoleConfigError(err instanceof Error && err.message ? err.message : i18n.t('角色部分配置自动生成失败，详情见日志'))
    setRoleConfigStatus('failed')
    markRoleConfigFailedSteps(scope)
    resetRoleConfigEnroll()
    const presetId = presetSnapshotRef.current?.presetId
    if (presetId) loadRoleConfigComplete(presetId)
  }, [loadRoleConfigComplete, resetRoleConfigEnroll, markRoleConfigFailedSteps])

  const enterRoleConfigReading = useCallback(async (controller: AbortController) => {
    if (roleConfigEnteringRef.current) return
    roleConfigEnteringRef.current = true
    try {
      if (!(await startRoleConfigTest(controller))) {
        if (controller.signal.aborted) return
        failRoleConfig(new Error(i18n.t('角色部分配置自动生成失败，详情见日志')), ['synthesize'])
        return
      }
      setRoleConfigStatus('reading')
    } finally {
      roleConfigEnteringRef.current = false
    }
  }, [startRoleConfigTest, failRoleConfig])

  const runRoleConfigSynthesize = useCallback(async (presetId: string, controller: AbortController) => {
    setRoleConfigStatus('collecting')
    setRoleConfigError(null)
    setRoleConfigSynthReady(false)
    setRoleConfigReadChoice('pending')
    setRoleConfigEnrollAsk(false)
    setRoleConfigEnrollError(null)
    try {
      const result = await streamRoleConfig<{ samples: RoleConfigSample[]; readings: RoleConfigReading[] }>(
        `/presets/${encodeURIComponent(presetId)}/role-config/synthesize`,
        undefined,
        controller
      )
      if (controller.signal.aborted) return
      if (!result) throw new Error(i18n.t('角色部分配置自动生成失败，详情见日志'))

      roleConfigSamplesRef.current = result.samples
      const read = roleConfigReadRef.current
      read.readings = result.readings
      read.transcripts = result.readings.map(() => null)
      read.target = null
      setRoleConfigReadings(result.readings)
      syncRoleConfigReading()
      setRoleConfigSynthReady(true)
    } catch (err) {
      if (err instanceof DOMException && err.name === 'AbortError') return
      if (controller.signal.aborted) return
      failRoleConfig(err, ['plugin', 'synthesize'])
    }
  }, [streamRoleConfig, syncRoleConfigReading, failRoleConfig])

  useEffect(() => {
    if (roleConfigStatus !== 'collecting' || !roleConfigSynthReady || roleConfigEnrollAsk || roleConfigReadChoice !== 'enter') return
    const controller = roleConfigControllerRef.current
    if (controller) void enterRoleConfigReading(controller)
  }, [roleConfigStatus, roleConfigSynthReady, roleConfigEnrollAsk, roleConfigReadChoice, enterRoleConfigReading])

  useEffect(() => {
    if (!roleConfigEnrollAsk) return
    const watchdog = createWatchdogEventSource({
      url: `${CORE_URL}/events`,
      listeners: { 'voice-status-changed': loadRoleConfigVoice },
      onOpen: loadRoleConfigVoice,
    })
    return () => {
      roleConfigVoiceSeqRef.current++
      watchdog.close()
    }
  }, [roleConfigEnrollAsk, loadRoleConfigVoice])

  const requestRoleConfigEnroll = useCallback(async (path: string) => {
    const controller = roleConfigEnrollControllerRef.current
    if (!controller) return
    setRoleConfigEnrollBusy(true)
    setRoleConfigEnrollError(null)
    try {
      const response = await fetch(`${CORE_URL}${path}`, { method: 'POST', signal: controller.signal })
      if (controller.signal.aborted) return
      if (!response.ok) {
        const payload = await response.json().catch(() => null)
        throw new Error(isErrorBody(payload) ? errorText(payload, i18n.t) : `HTTP ${response.status}`)
      }
    } catch (err) {
      if (controller.signal.aborted) return
      if (!(path === '/voice/enroll/commit' && roleConfigEnrollInterruptedRef.current)) {
        setRoleConfigEnrollError(err instanceof Error ? err.message : i18n.t('操作失败，请稍后重试'))
      }
    } finally {
      if (!controller.signal.aborted) {
        setRoleConfigEnrollBusy(false)
        loadRoleConfigVoice()
      }
    }
  }, [loadRoleConfigVoice])

  const handleRoleConfigEnrollStart = useCallback(async () => {
    const controller = roleConfigEnrollControllerRef.current
    if (!controller) return
    setRoleConfigEnrollBusy(true)
    setRoleConfigEnrollInterrupted(false)
    setRoleConfigEnrollError(null)
    roleConfigEnrollSentRef.current = true
    try {
      const response = await fetch(`${CORE_URL}/voice/enroll/start`, { method: 'POST', signal: controller.signal })
      if (controller.signal.aborted) return
      if (!response.ok) {
        const payload = await response.json().catch(() => null)
        throw new Error(isErrorBody(payload) ? errorText(payload, i18n.t) : `HTTP ${response.status}`)
      }
      roleConfigEnrollingRef.current = true
      setRoleConfigEnrolling(true)
    } catch (err) {
      if (controller.signal.aborted) return
      roleConfigEnrollSentRef.current = false
      setRoleConfigEnrollError(err instanceof Error ? err.message : i18n.t('操作失败，请稍后重试'))
    } finally {
      if (!controller.signal.aborted) {
        setRoleConfigEnrollBusy(false)
        loadRoleConfigVoice()
      }
    }
  }, [loadRoleConfigVoice])

  const handleRoleConfigEnrollCommit = useCallback(() => requestRoleConfigEnroll('/voice/enroll/commit'), [requestRoleConfigEnroll])

  const handleRoleConfigEnrollCancel = useCallback(() => requestRoleConfigEnroll('/voice/enroll/cancel'), [requestRoleConfigEnroll])

  const handleRoleConfigEnrollSkip = useCallback(() => {
    setRoleConfigEnrollError(null)
    setRoleConfigEnrollInterrupted(false)
    setRoleConfigEnrollAsk(false)
  }, [])

  const consumeRoleConfigResults = useCallback((results: VoiceTestResultText[]) => {
    const read = roleConfigReadRef.current
    let changed = false
    for (; read.seen < results.length; read.seen++) {
      const result = results[read.seen]
      const text = result.textRaw || result.text
      if (result.kind === 'other' || !text || text.trim() === '') continue
      const index = currentReadingIndex(read)
      if (index < 0) continue
      read.transcripts[index] = text
      read.target = null
      changed = true
    }
    if (!changed) return
    syncRoleConfigReading()
    if (read.transcripts.includes(null)) {
      armRoleConfigReadTimer()
    } else {
      clearRoleConfigReadTimer()
      stopRoleConfigTest()
    }
  }, [syncRoleConfigReading, stopRoleConfigTest, armRoleConfigReadTimer, clearRoleConfigReadTimer])

  useEffect(() => {
    if (roleConfigStatus !== 'reading') return
    let seq = 0
    const load = () => {
      const mine = ++seq
      const startCount = roleConfigTestStartCountRef.current
      fetch(`${CORE_URL}/voice/status`)
        .then(r => {
          if (!r.ok) throw new Error(`HTTP ${r.status}`)
          return r.json()
        })
        .then((body: { mode: string; test: { results: VoiceTestResultText[] } }) => {
          if (mine !== seq) return
          if (startCount !== roleConfigTestStartCountRef.current) return
          consumeRoleConfigResults(body.test.results)
          const read = roleConfigReadRef.current
          if (read.testActive && body.mode !== 'testing') {
            read.testActive = false
            clearRoleConfigReadTimer()
            setRoleConfigReadInterrupted(true)
          }
        })
        .catch((err: unknown) => {
          console.error('[CharacterPanel] 读取语音状态失败', err)
        })
    }
    const watchdog = createWatchdogEventSource({
      url: `${CORE_URL}/events`,
      listeners: { 'voice-status-changed': load },
      onOpen: load,
    })
    return () => {
      seq++
      watchdog.close()
    }
  }, [roleConfigStatus, consumeRoleConfigResults, clearRoleConfigReadTimer])

  const handleRoleConfigRerecord = useCallback(async (index: number) => {
    const controller = roleConfigControllerRef.current
    if (!controller || roleConfigReadStartingRef.current) return
    const read = roleConfigReadRef.current
    if (!read.testActive && !(await startRoleConfigTest(controller))) {
      if (!controller.signal.aborted) failRoleConfig(null, ['synthesize'])
      return
    }
    read.transcripts[index] = null
    read.target = index
    syncRoleConfigReading()
    armRoleConfigReadTimer()
  }, [startRoleConfigTest, failRoleConfig, syncRoleConfigReading, armRoleConfigReadTimer])

  const handleRoleConfigContinue = useCallback(async () => {
    const controller = roleConfigControllerRef.current
    if (!controller || roleConfigReadStartingRef.current) return
    if (!(await startRoleConfigTest(controller)) && !controller.signal.aborted) failRoleConfig(null, ['synthesize'])
  }, [startRoleConfigTest, failRoleConfig])

  const runRoleConfigFinish = useCallback(async (recorded: RoleConfigSample[]) => {
    if (roleConfigFinishingRef.current) return
    const presetId = presetSnapshotRef.current?.presetId
    if (!presetId) return

    roleConfigFinishingRef.current = true
    setRoleConfigVoiceDone(true)
    roleConfigControllerRef.current?.abort()
    const controller = new AbortController()
    roleConfigControllerRef.current = controller
    setRoleConfigStatus('finishing')
    setRoleConfigError(null)

    try {
      const result = await streamRoleConfig<{ complete: boolean }>(
        `/presets/${encodeURIComponent(presetId)}/role-config/finish`,
        { samples: [...roleConfigSamplesRef.current, ...recorded] },
        controller
      )
      if (controller.signal.aborted) return
      if (!result) throw new Error(i18n.t('角色部分配置自动生成失败，详情见日志'))
      setRoleConfigStatus('saved')
      loadRoleConfigComplete(presetId)
    } catch (err) {
      if (err instanceof DOMException && err.name === 'AbortError') return
      if (controller.signal.aborted) return
      failRoleConfig(err, ['analyze', 'write'])
    } finally {
      roleConfigFinishingRef.current = false
    }
  }, [streamRoleConfig, loadRoleConfigComplete, failRoleConfig])

  const handleRoleConfigFinish = useCallback(() => {
    const read = roleConfigReadRef.current
    if (read.transcripts.includes(null)) return
    const recorded = read.readings.map((reading, index) => ({ ...reading, transcript: read.transcripts[index] as string }))
    return runRoleConfigFinish(recorded)
  }, [runRoleConfigFinish])

  const handleRoleConfigReadEnter = useCallback(() => {
    setRoleConfigReadChoice('enter')
  }, [])

  const handleRoleConfigReadSkip = useCallback(() => {
    setRoleConfigReadChoice('confirmingSkip')
  }, [])

  const handleRoleConfigReadSkipConfirm = useCallback(() => runRoleConfigFinish([]), [runRoleConfigFinish])

  const handleRoleConfigStart = useCallback(async () => {
    const presetId = presetSnapshotRef.current?.presetId
    if (!presetId) return

    roleConfigControllerRef.current?.abort()
    const controller = new AbortController()
    roleConfigControllerRef.current = controller
    resetRoleConfigEnroll()
    setRoleConfigStatus('looking')
    setRoleConfigLookup(null)
    setRoleConfigSelected(null)
    setRoleConfigSteps({})
    setRoleConfigMainName(null)
    setRoleConfigNames([])
    setRoleConfigInput('')
    setRoleConfigSaved('')
    setRoleConfigGreetName('')
    setRoleConfigPluginKind('check')
    setRoleConfigVoiceDone(false)
    setRoleConfigReadChoice('pending')
    setRoleConfigError(null)
    setRoleConfigReadings([])
    setRoleConfigTranscripts([])
    setRoleConfigCurrent(-1)

    try {
      const response = await fetch(`${CORE_URL}/presets/${encodeURIComponent(presetId)}/role-config/lookup`, {
        method: 'POST',
        signal: controller.signal,
      })

      if (!response.ok) {
        const body = await response.json().catch(() => null)
        throw new Error(isErrorBody(body) ? errorText(body, i18n.t) : i18n.t('生成角色配置失败，请稍后重试'))
      }

      let result: RoleConfigLookup | null = null
      for await (const { event, data } of parseSSE(response)) {
        if (controller.signal.aborted) return
        if (event === 'step') {
          const { step, state } = data as { step: RoleConfigStep; state: RoleConfigStepState }
          setRoleConfigSteps(prev => ({ ...prev, [step]: state }))
        } else if (event === 'result') {
          result = data as RoleConfigLookup
        }
      }
      if (controller.signal.aborted) return
      if (!result) throw new Error(i18n.t('生成角色配置失败，请稍后重试'))

      setRoleConfigLookup(result)
      if (result.kind === 'candidates' && result.candidates.length >= 2) {
        setRoleConfigStatus('choosing')
        return
      }
      const selected = result.kind === 'candidates' ? 0 : null
      const choice = roleConfigChoice(result, selected)
      setRoleConfigSelected(selected)
      setRoleConfigMainName(choice.mainName)
      setRoleConfigNames(cleanNames(choice.names).map(name => ({ name, selected: false })))
      setRoleConfigStatus('naming')
    } catch (err) {
      if (err instanceof DOMException && err.name === 'AbortError') return
      if (controller.signal.aborted) return
      setRoleConfigError(err instanceof Error && err.message ? err.message : i18n.t('生成角色配置失败，请稍后重试'))
      setRoleConfigStatus('error')
      markRoleConfigFailedSteps(['extract', 'search', 'merge'])
    }
  }, [resetRoleConfigEnroll, markRoleConfigFailedSteps])

  const handleRoleConfigNext = useCallback(() => {
    if (!roleConfigLookup || roleConfigSelected === null) return
    const choice = roleConfigChoice(roleConfigLookup, roleConfigSelected)
    setRoleConfigMainName(choice.mainName)
    setRoleConfigNames(cleanNames(choice.names).map(name => ({ name, selected: false })))
    setRoleConfigInput('')
    setRoleConfigError(null)
    setRoleConfigStatus('naming')
  }, [roleConfigLookup, roleConfigSelected])

  const handleRoleConfigPrevious = useCallback(() => {
    setRoleConfigError(null)
    setRoleConfigStatus('choosing')
  }, [])

  const handleRoleConfigCancel = useCallback(() => {
    roleConfigControllerRef.current?.abort()
    clearRoleConfigReadTimer()
    stopRoleConfigTest()
    resetRoleConfigEnroll()
    setRoleConfigStatus('idle')
    setRoleConfigLookup(null)
    setRoleConfigSelected(null)
    setRoleConfigSteps({})
    setRoleConfigMainName(null)
    setRoleConfigNames([])
    setRoleConfigInput('')
    setRoleConfigSaved('')
    setRoleConfigGreetName('')
    setRoleConfigPluginKind('check')
    setRoleConfigVoiceDone(false)
    setRoleConfigReadChoice('pending')
    setRoleConfigError(null)
    setRoleConfigReadings([])
    setRoleConfigTranscripts([])
    setRoleConfigCurrent(-1)
    setRoleConfigReadInterrupted(false)
    const presetId = presetSnapshotRef.current?.presetId
    if (presetId) loadRoleConfigComplete(presetId)
  }, [stopRoleConfigTest, clearRoleConfigReadTimer, resetRoleConfigEnroll, loadRoleConfigComplete])

  const handleRoleConfigToggleName = useCallback((name: string) => {
    setRoleConfigNames(prev => prev.map(item => (item.name === name ? { ...item, selected: !item.selected } : item)))
  }, [])

  const handleRoleConfigAddNames = useCallback(() => {
    const added = cleanNames(roleConfigInput.split(/[|/、]/))
    if (added.length === 0) return
    setRoleConfigNames(prev => addRoleConfigNames(prev, added))
    setRoleConfigInput('')
  }, [roleConfigInput])

  const handleRoleConfigConfirm = useCallback(async () => {
    const presetId = presetSnapshotRef.current?.presetId
    if (!presetId) return
    const added = cleanNames(roleConfigInput.split(/[|/、]/))
    const nextNames = addRoleConfigNames(roleConfigNames, added)
    const chosen = nextNames.filter(item => item.selected).map(item => item.name)
    if (chosen.length === 0) return
    setRoleConfigNames(nextNames)
    setRoleConfigInput('')

    roleConfigControllerRef.current?.abort()
    const controller = new AbortController()
    roleConfigControllerRef.current = controller
    setRoleConfigStatus('saving')
    setRoleConfigError(null)

    try {
      const response = await fetch(`${CORE_URL}/presets/${encodeURIComponent(presetId)}/role-config/confirm`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ names: chosen }),
        signal: controller.signal,
      })

      if (!response.ok) {
        const body = await response.json().catch(() => null)
        throw new Error(isErrorBody(body) ? errorText(body, i18n.t) : i18n.t('保存称呼失败，请稍后重试'))
      }

      const { names }: { names: string[] } = await response.json()
      if (controller.signal.aborted) return

      loadRoleConfigComplete(presetId)
      setRoleConfigSaved(i18n.t('已保存：{{names}}', { names: names.join('、') }))
      setRoleConfigGreetName(names[0] ?? '')
      setRoleConfigLookup(null)
      setRoleConfigSelected(null)
      setRoleConfigMainName(null)
      setRoleConfigNames([])
      setRoleConfigInput('')
      await runRoleConfigSynthesize(presetId, controller)
    } catch (err) {
      if (err instanceof DOMException && err.name === 'AbortError') return
      if (controller.signal.aborted) return
      setRoleConfigError(err instanceof Error && err.message ? err.message : i18n.t('保存称呼失败，请稍后重试'))
      setRoleConfigStatus('naming')
    }
  }, [roleConfigNames, roleConfigInput, runRoleConfigSynthesize, loadRoleConfigComplete])

  const roleConfigGreetingSentRef = useRef(false)

  const handleRoleConfigGreet = useCallback(async () => {
    if (roleConfigGreetingSentRef.current) return
    roleConfigGreetingSentRef.current = true
    const hour = new Date().getHours()
    const call = roleConfigGreetName
    const greeting = hour >= 5 && hour < 11
      ? i18n.t('{{call}}，早上好！', { call })
      : hour >= 11 && hour < 13
        ? i18n.t('{{call}}，中午好！', { call })
        : hour >= 13 && hour < 18
          ? i18n.t('{{call}}，下午好！', { call })
          : hour >= 18 && hour < 23
            ? i18n.t('{{call}}，晚上好！', { call })
            : i18n.t('{{call}}，还没睡吗？', { call })
    handleRoleConfigCancel()
    try {
      await window.electronAPI.sendGreeting(greeting)
    } catch (err) {
      console.error('[CharacterPanel] 发送打招呼失败', err)
    }
  }, [roleConfigGreetName, handleRoleConfigCancel])

  const handleSystemPromptEditStart = useCallback(() => {
    setSystemPromptValue(presetSnapshotRef.current?.systemPrompt ?? '')
    setPersonaError(null)
    setSystemPromptNotice(null)
    setSystemPromptStep('editing')
  }, [])

  const handleSystemPromptEditCancel = useCallback(() => {
    setSystemPromptStep('idle')
    setPersonaError(null)
  }, [])

  const handleSystemPromptSaveClick = useCallback(() => {
    if (!systemPromptValue.trim()) {
      setPersonaError(i18n.t('人设内容不能为空'))
      return
    }
    setPersonaError(null)
    setSystemPromptStep('confirmingSave')
  }, [systemPromptValue])

  const handleSystemPromptConfirmSaveCancel = useCallback(() => {
    setSystemPromptStep('editing')
  }, [])

  const handleSystemPromptConfirmSaveConfirm = useCallback(() => {
    setSystemPromptStep('confirmingApply')
  }, [])

  const handleSystemPromptConfirmApplyCancel = useCallback(() => {
    setSystemPromptStep('editing')
  }, [])

  const handleSystemPromptSend = useCallback(async (applyNow: boolean) => {
    const presetId = presetSnapshotRef.current?.presetId
    if (!presetId) return

    const trimmedValue = systemPromptValue.trim()
    if (!trimmedValue) return

    systemPromptControllerRef.current?.abort()
    const controller = new AbortController()
    systemPromptControllerRef.current = controller
    setSystemPromptStep('saving')
    setPersonaError(null)

    try {
      const response = await fetch(`${CORE_URL}/presets/${encodeURIComponent(presetId)}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ systemPrompt: trimmedValue, applyNow }),
        signal: controller.signal,
      })

      if (!response.ok) {
        throw new Error(`HTTP ${response.status}`)
      }

      const state: AppState = await response.json()
      if (controller.signal.aborted) return

      if (state.presetSnapshot?.presetId === presetSnapshotRef.current?.presetId) {
        onSwitched(state)
        if (!applyNow) {
          setSystemPromptNotice(i18n.t('此次修改将在下次重新启用『{{name}}』时生效。', { name: presetSnapshotRef.current?.name ?? '' }))
        }
        setSystemPromptStep('idle')
      }
    } catch (err) {
      if (err instanceof DOMException && err.name === 'AbortError') return
      if (presetId !== presetSnapshotRef.current?.presetId) return
      setPersonaError(i18n.t('保存人设失败，请稍后重试'))
      setSystemPromptStep('editing')
    }
  }, [systemPromptValue, onSwitched])

  const overrideKeyProvider: KeyProvider | null = overrideModelType === 'ollama' ? null : overrideModelType
  const summaryKeyProvider: KeyProvider | null = summarySameAsChat || summaryModelType === 'ollama' ? null : summaryModelType
  const needsModelKeys = !useGlobalModel && (overrideKeyProvider !== null || summaryKeyProvider !== null)
  const overrideKeysReady = !needsModelKeys || modelKeysStatus === 'ready'

  const resetOverrideKeyState = useCallback(() => {
    setOverrideKeyInput('')
    setOverrideKeyEditing(false)
    setOverrideFromEnvChoice(null)
  }, [])

  const resetSummaryKeyState = useCallback(() => {
    setSummaryKeyInput('')
    setSummaryKeyEditing(false)
    setSummaryFromEnvChoice(null)
  }, [])

  const handleModelOverrideEditStart = useCallback(() => {
    setUseGlobalModel(presetSnapshotRef.current?.modelType === null)
    setOverrideModelType(presetSnapshotRef.current?.modelType ?? 'anthropic')
    setOverrideModelName(presetSnapshotRef.current?.modelName ?? '')
    resetOverrideKeyState()
    setSummarySameAsChat((presetSnapshotRef.current?.summaryModelType ?? null) === null)
    setSummaryModelType(presetSnapshotRef.current?.summaryModelType ?? 'anthropic')
    setSummaryModelName(presetSnapshotRef.current?.summaryModelName ?? '')
    resetSummaryKeyState()
    const presetId = presetSnapshotRef.current?.presetId
    if (presetId) loadModelKeys(presetId)
    loadEnvDetected()
    setPersonaError(null)
    setModelOverrideNotice(null)
    setModelOverrideStep('editing')
  }, [resetOverrideKeyState, resetSummaryKeyState, loadModelKeys, loadEnvDetected])

  const handleModelOverrideEditCancel = useCallback(() => {
    resetOverrideKeyState()
    resetSummaryKeyState()
    setModelOverrideStep('idle')
    setPersonaError(null)
  }, [resetOverrideKeyState, resetSummaryKeyState])

  const handleOverrideModelTypeChange = useCallback((type: ModelConfig['type']) => {
    setOverrideModelType(type)
    setOverrideModelName('')
    resetOverrideKeyState()
  }, [resetOverrideKeyState])

  const handleOverrideFromEnvChange = useCallback((checked: boolean) => {
    setOverrideFromEnvChoice(checked)
    if (checked) {
      setOverrideKeyInput('')
      setOverrideKeyEditing(false)
    }
  }, [])

  const handleSummaryModelTypeChange = useCallback((type: ModelConfig['type']) => {
    setSummaryModelType(type)
    setSummaryModelName('')
    resetSummaryKeyState()
  }, [resetSummaryKeyState])

  const handleSummaryFromEnvChange = useCallback((checked: boolean) => {
    setSummaryFromEnvChoice(checked)
    if (checked) {
      setSummaryKeyInput('')
      setSummaryKeyEditing(false)
    }
  }, [])

  const handleModelOverrideSaveClick = useCallback(() => {
    if (!useGlobalModel && !overrideModelName.trim()) {
      setPersonaError(i18n.t('模型名称不能为空'))
      return
    }
    if (!useGlobalModel && !summarySameAsChat && !summaryModelName.trim()) {
      setPersonaError(i18n.t('摘要模型名称不能为空'))
      return
    }
    if (!overrideKeysReady) return
    setPersonaError(null)
    setModelOverrideStep('chooseApply')
  }, [useGlobalModel, overrideModelName, summarySameAsChat, summaryModelName, overrideKeysReady])

  const handleModelOverrideChooseApplyCancel = useCallback(() => {
    setModelOverrideStep('editing')
  }, [])

  const handleModelOverrideSend = useCallback(async (applyNow: boolean) => {
    const presetId = presetSnapshotRef.current?.presetId
    if (!presetId) return

    const modelType = useGlobalModel ? null : overrideModelType
    const trimmedModelName = useGlobalModel ? null : overrideModelName.trim()
    if (!useGlobalModel && !trimmedModelName) return

    const keyFields: { apiKey?: string; apiKeyFromEnv?: boolean } = {}
    if (!useGlobalModel && overrideModelType !== 'ollama') {
      const typedKey = overrideKeyInput.trim()
      if (typedKey) keyFields.apiKey = typedKey
      if (overrideFromEnvChoice !== null) keyFields.apiKeyFromEnv = overrideFromEnvChoice
      else if (modelKeys) keyFields.apiKeyFromEnv = modelKeys[overrideModelType].fromEnv
    }
    const summaryFields: {
      summaryModelType?: ModelConfig['type'] | null
      summaryModelName?: string | null
      summaryApiKey?: string
      summaryApiKeyFromEnv?: boolean
    } = {}
    if (!useGlobalModel) {
      if (summarySameAsChat) {
        summaryFields.summaryModelType = null
        summaryFields.summaryModelName = null
      } else {
        const trimmedSummaryName = summaryModelName.trim()
        if (!trimmedSummaryName) return
        summaryFields.summaryModelType = summaryModelType
        summaryFields.summaryModelName = trimmedSummaryName
        if (summaryModelType !== 'ollama') {
          const typedSummaryKey = summaryKeyInput.trim()
          if (typedSummaryKey) summaryFields.summaryApiKey = typedSummaryKey
          if (summaryFromEnvChoice !== null) summaryFields.summaryApiKeyFromEnv = summaryFromEnvChoice
          else if (modelKeys) summaryFields.summaryApiKeyFromEnv = modelKeys[summaryModelType].summary.fromEnv
        }
      }
    }
    let serverError: string | null = null

    modelOverrideControllerRef.current?.abort()
    const controller = new AbortController()
    modelOverrideControllerRef.current = controller
    setModelOverrideStep('saving')
    setPersonaError(null)

    try {
      const response = await fetch(`${CORE_URL}/presets/${encodeURIComponent(presetId)}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ modelType, modelName: trimmedModelName, applyNow, ...keyFields, ...summaryFields }),
        signal: controller.signal,
      })

      if (!response.ok) {
        const payload = await response.json().catch(() => null)
        if (isErrorBody(payload)) serverError = errorText(payload, i18n.t)
        throw new Error(`HTTP ${response.status}`)
      }

      const state: AppState = await response.json()
      if (controller.signal.aborted) return

      if (state.presetSnapshot?.presetId === presetSnapshotRef.current?.presetId) {
        onSwitched(state)
        resetOverrideKeyState()
        resetSummaryKeyState()
        if (needsModelKeys) loadModelKeys(presetId)
        if (!applyNow) {
          setModelOverrideNotice(i18n.t('此次修改将在下次重新启用『{{name}}』时生效。', { name: presetSnapshotRef.current?.name ?? '' }))
        }
        setModelOverrideStep('idle')
      }
    } catch (err) {
      if (err instanceof DOMException && err.name === 'AbortError') return
      if (presetId !== presetSnapshotRef.current?.presetId) return
      setPersonaError(serverError ?? i18n.t('保存模型设置失败，请稍后重试'))
      setModelOverrideStep('editing')
    }
  }, [useGlobalModel, overrideModelType, overrideModelName, overrideKeyInput, overrideFromEnvChoice, summarySameAsChat, summaryModelType, summaryModelName, summaryKeyInput, summaryFromEnvChoice, needsModelKeys, modelKeys, onSwitched, resetOverrideKeyState, resetSummaryKeyState, loadModelKeys])

  const sendDisplayConfigPatch = useCallback((presetId: string, partial: Partial<PresetDisplayConfig>) => {
    displayConfigControllerRef.current?.abort()
    const controller = new AbortController()
    displayConfigControllerRef.current = controller

    fetch(`${CORE_URL}/presets/${encodeURIComponent(presetId)}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ displayConfig: partial }),
      signal: controller.signal,
    })
      .then(response => {
        if (!response.ok) throw new Error(`HTTP ${response.status}`)
        return response.json() as Promise<AppState>
      })
      .then(state => {
        if (controller.signal.aborted) return
        if (state.presetSnapshot?.presetId === presetSnapshotRef.current?.presetId) {
          onSwitched(state)
        }
      })
      .catch(err => {
        if (err instanceof DOMException && err.name === 'AbortError') return
        setAppearanceError(i18n.t('颜色/透明度保存失败，请稍后重试'))
      })
  }, [onSwitched])

  const flushPendingDisplayConfig = useCallback(() => {
    if (displayConfigDebounceRef.current) {
      clearTimeout(displayConfigDebounceRef.current)
      displayConfigDebounceRef.current = null
    }
    const pending = pendingDisplayConfigRef.current
    pendingDisplayConfigRef.current = null
    if (pending) {
      sendDisplayConfigPatch(pending.presetId, pending.partial)
    }
  }, [sendDisplayConfigPatch])

  const scheduleDisplayConfigChange = useCallback((partial: Partial<PresetDisplayConfig>) => {
    const presetId = presetSnapshotRef.current?.presetId
    if (!presetId) return

    const prevPending = pendingDisplayConfigRef.current
    pendingDisplayConfigRef.current = {
      presetId,
      partial: prevPending?.presetId === presetId ? { ...prevPending.partial, ...partial } : partial,
    }

    if (displayConfigDebounceRef.current) clearTimeout(displayConfigDebounceRef.current)
    displayConfigDebounceRef.current = setTimeout(flushPendingDisplayConfig, DISPLAY_CONFIG_DEBOUNCE_MS)
  }, [flushPendingDisplayConfig])

  const handleOpacityChange = useCallback((e: ChangeEvent<HTMLInputElement>) => {
    const opacity = Number(e.target.value)
    setChatBgOpacity(opacity)
    scheduleDisplayConfigChange({ chatBgOpacity: opacity })
  }, [scheduleDisplayConfigChange])

  const handleNoColorClick = useCallback(() => {
    setChatBgOpacity(0)
    scheduleDisplayConfigChange({ chatBgOpacity: 0 })
  }, [scheduleDisplayConfigChange])

  const handleThemeModeChange = useCallback((e: ChangeEvent<HTMLSelectElement>) => {
    const mode = e.target.value as PresetDisplayConfig['themeMode']
    setThemeMode(mode)
    scheduleDisplayConfigChange({ themeMode: mode })
  }, [scheduleDisplayConfigChange])

  const handleAccentColorChange = useCallback((e: ChangeEvent<HTMLInputElement>) => {
    const rgb = hexToRgb(e.target.value)
    setAccentRgb(rgb)
    scheduleDisplayConfigChange({ accentRgb: rgb })
  }, [scheduleDisplayConfigChange])

  const handleTintChange = useCallback((e: ChangeEvent<HTMLInputElement>) => {
    const tint = percentToTintStrength(Number(e.target.value))
    setTintStrength(tint)
    scheduleDisplayConfigChange({ tintStrength: tint })
  }, [scheduleDisplayConfigChange])

  const handleResetTint = useCallback(() => {
    setTintStrength(0)
    scheduleDisplayConfigChange({ tintStrength: 0 })
  }, [scheduleDisplayConfigChange])

  const savedPortrait = presetSnapshot?.displayConfig?.currentPortrait ?? DEFAULT_DISPLAY_CONFIG.currentPortrait
  const effectivePortrait = (portraitForms && resolveEffectiveForm(savedPortrait, portraitForms)) ?? savedPortrait
  const otherPortrait: PortraitFormName = effectivePortrait === 'pixel' ? 'illustration' : 'pixel'
  const canSwitchPortrait = portraitForms !== null && isPortraitFormAvailable(portraitForms[otherPortrait])

  const handlePortraitToggle = useCallback(() => {
    const presetId = presetSnapshotRef.current?.presetId
    if (!presetId) return
    setAppearanceError(null)
    setIsSwitchingPortrait(true)
    fetch(`${CORE_URL}/presets/${encodeURIComponent(presetId)}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ displayConfig: { currentPortrait: otherPortrait } }),
    })
      .then(response => {
        if (!response.ok) throw new Error(`HTTP ${response.status}`)
        return response.json() as Promise<AppState>
      })
      .then(state => {
        if (state.presetSnapshot?.presetId === presetSnapshotRef.current?.presetId) {
          onSwitched(state)
        }
      })
      .catch(() => {
        setAppearanceError(i18n.t('形态切换失败，请稍后重试'))
      })
      .finally(() => setIsSwitchingPortrait(false))
  }, [otherPortrait, onSwitched])

  const characterIdOptions = importedCardFields && createCharacterId && !characterIds.includes(createCharacterId)
    ? [{ value: createCharacterId, label: i18n.t('（新导入）{{id}}', { id: createCharacterId }) }, ...characterIds.map(id => ({ value: id, label: id }))]
    : characterIds.map(id => ({ value: id, label: id }))

  const overrideKeySummary = (overrideKeyProvider && modelKeys?.[overrideKeyProvider]) || BLANK_MODEL_KEY
  const overrideEnvDetected = overrideKeyProvider ? envDetected[overrideKeyProvider] : false
  const overrideFromEnv = overrideFromEnvChoice ?? overrideKeySummary.fromEnv
  const summaryKeySummary = (summaryKeyProvider && modelKeys?.[summaryKeyProvider]?.summary) || BLANK_MODEL_KEY
  const summaryEnvDetected = summaryKeyProvider ? envDetected[summaryKeyProvider] : false
  const summaryFromEnv = summaryFromEnvChoice ?? summaryKeySummary.fromEnv

  return {
    presetSnapshot,
    presets,
    switchPreset,
    switchError,
    characterError,
    appearanceError,
    personaError,
    isUploadingWallpaper,
    isRenaming,
    renameValue,
    setRenameValue,
    isSavingRename,
    renameInputWidth,
    presetNameRef,
    renameInputRef,
    deleteTarget,
    isDeleting,
    isSwitchingPreset,
    isCreating,
    createName,
    setCreateName,
    createCharacterId,
    setCreateCharacterId,
    createSystemPrompt,
    setCreateSystemPrompt,
    isSavingCreate,
    isImportingCard,
    isGeneratingSystemPrompt,
    importedCardFields,
    characterIdOptions,
    systemPromptStep,
    systemPromptValue,
    setSystemPromptValue,
    systemPromptNotice,
    modelOverrideStep,
    useGlobalModel,
    setUseGlobalModel,
    overrideModelType,
    setOverrideModelType,
    overrideModelName,
    setOverrideModelName,
    handleOverrideModelTypeChange,
    overrideKeyProvider,
    overrideKeySummary,
    overrideEnvDetected,
    overrideFromEnv,
    overrideKeysReady,
    modelKeysStatus,
    envStatus,
    retryModelKeys,
    loadEnvDetected,
    overrideKeyInput,
    setOverrideKeyInput,
    overrideKeyEditing,
    setOverrideKeyEditing,
    handleOverrideFromEnvChange,
    summarySameAsChat,
    setSummarySameAsChat,
    summaryModelType,
    summaryModelName,
    setSummaryModelName,
    handleSummaryModelTypeChange,
    summaryKeyProvider,
    summaryKeySummary,
    summaryEnvDetected,
    summaryFromEnv,
    summaryKeyInput,
    setSummaryKeyInput,
    summaryKeyEditing,
    setSummaryKeyEditing,
    handleSummaryFromEnvChange,
    modelOverrideNotice,
    chatBgOpacity,
    themeMode,
    accentRgb,
    tintStrength,
    previewResolvedMode,
    previewVars,
    previewWallpaperUrl,
    effectivePortrait,
    otherPortrait,
    canSwitchPortrait,
    portraitForms,
    isSwitchingPortrait,
    handleWallpaperPick,
    handlePortraitToggle,
    handleRenameStart,
    handleRenameCancel,
    handleRenameSave,
    handleDeleteStart,
    handleDeleteCancel,
    handleDeleteConfirm,
    handleCreateStart,
    handleCreateCancel,
    handleImportCardPick,
    handleRegenerateSystemPrompt,
    handleCreateSave,
    roleConfigStatus,
    roleConfigLookup,
    roleConfigSelected,
    setRoleConfigSelected,
    roleConfigSteps,
    roleConfigMainName,
    roleConfigNames,
    roleConfigInput,
    setRoleConfigInput,
    roleConfigSaved,
    roleConfigPluginKind,
    roleConfigVoiceDone,
    roleConfigReadChoice,
    roleConfigSynthReady,
    handleRoleConfigReadEnter,
    handleRoleConfigReadSkip,
    handleRoleConfigReadSkipConfirm,
    handleRoleConfigGreet,
    roleConfigError,
    roleConfigComplete,
    roleConfigCompleteFailed,
    roleConfigReadInterrupted,
    roleConfigReadStarting,
    handleRoleConfigContinue,
    roleConfigReadings,
    roleConfigTranscripts,
    roleConfigCurrent,
    roleConfigEnrollAsk,
    roleConfigEnrolling,
    roleConfigEnrollBusy,
    roleConfigEnrollInterrupted,
    roleConfigEnrollError,
    roleConfigVoice,
    handleRoleConfigEnrollStart,
    handleRoleConfigEnrollCommit,
    handleRoleConfigEnrollCancel,
    handleRoleConfigEnrollSkip,
    handleRoleConfigRerecord,
    handleRoleConfigFinish,
    handleRoleConfigStart,
    handleRoleConfigNext,
    handleRoleConfigPrevious,
    handleRoleConfigCancel,
    handleRoleConfigToggleName,
    handleRoleConfigAddNames,
    handleRoleConfigConfirm,
    handleSystemPromptEditStart,
    handleSystemPromptEditCancel,
    handleSystemPromptSaveClick,
    handleSystemPromptConfirmSaveCancel,
    handleSystemPromptConfirmSaveConfirm,
    handleSystemPromptConfirmApplyCancel,
    handleSystemPromptSend,
    handleModelOverrideEditStart,
    handleModelOverrideEditCancel,
    handleModelOverrideSaveClick,
    handleModelOverrideChooseApplyCancel,
    handleModelOverrideSend,
    handleOpacityChange,
    handleNoColorClick,
    handleThemeModeChange,
    handleAccentColorChange,
    handleTintChange,
    handleResetTint,
  }
}

export type CharacterPanelModel = ReturnType<typeof useCharacterPanel>
