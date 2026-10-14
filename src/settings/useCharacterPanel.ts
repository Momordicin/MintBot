// src/settings/useCharacterPanel.ts — 设置窗口角色相关页面（角色 / 外观 / 人设与模型）共用的状态与操作
// 用法：SettingsApp 调用 useCharacterPanel({ presetSnapshot, onSwitched })，把返回值传给 CharacterPanel / AppearancePanel / PersonaModelPanel，并用其中的 presets / switchPreset 渲染左栏角色下拉框；GET /presets、/presets/:id/model-keys、/config/model、/characters、/characters/:id/manifest.json，POST /switch-preset、/presets、/presets/:id/wallpaper、/characters/import/{parse,generate}、/characters/:id/{avatar,metadata}，PATCH /presets/:id，DELETE /presets/:id；electronAPI.selectWallpaperFile / selectCharacterCardFile
// 对应文件：src/settings/SettingsApp.tsx / src/settings/CharacterPanel.tsx / src/settings/AppearancePanel.tsx / src/settings/PersonaModelPanel.tsx / src/settings/themeControls.ts / src/chat/theme.ts / src/chat/themeVars.ts / shared/portraitForm.ts / services/core/index.ts / services/core/routes/presets.ts / services/core/routes/characterImport.ts / electron/main/index.ts（select-wallpaper-file、select-character-card-file）
import { useCallback, useEffect, useMemo, useRef, useState, type ChangeEvent } from 'react'
import type { AppState, ModelConfig, PresetDisplayConfig, PresetSnapshot } from '../../shared/types/index.js'
import { hexToRgb, percentToTintStrength } from './themeControls.js'
import { deriveTheme } from '../chat/theme.js'
import { resolveThemeMode, themeCssVars } from '../chat/themeVars.js'
import { usePrefersDark } from '../usePrefersDark.js'
import type { ApiKeySummary, KeyProvider } from './ApiKeyField.js'
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
        setCharacterError('角色文件夹列表加载失败，无法创建新角色，请检查核心服务后重试')
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
        setSwitchError('切换角色失败，请稍后重试')
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
        setAppearanceError('图片文件过大，请选择小于 10MB 的图片')
        return
      }
      setAppearanceError('更换壁纸失败，请稍后重试')
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
      setCharacterError('名称不能为空')
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
      setCharacterError('重命名失败，请稍后重试')
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
        setCharacterError('至少需要保留一个角色')
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
      setCharacterError('删除失败，请稍后重试')
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
        throw new Error(typeof body?.error === 'string' ? body.error : `HTTP ${response.status}`)
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
        setCharacterError('角色卡文件过大，请选择小于 5MB 的文件')
        return
      }
      setCharacterError(err instanceof Error && err.message ? err.message : '导入角色卡失败，请稍后重试')
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
      setCharacterError('模型辅助改写失败，请稍后重试')
    } finally {
      setIsGeneratingSystemPrompt(false)
    }
  }, [importedCardFields, isGeneratingSystemPrompt])

  const handleCreateSave = useCallback(async () => {
    const trimmedName = createName.trim()
    const trimmedCharacterId = createCharacterId.trim()
    const trimmedSystemPrompt = createSystemPrompt.trim()
    if (!trimmedName) {
      setCharacterError('名称不能为空')
      return
    }
    if (!trimmedCharacterId) {
      setCharacterError('角色包 ID 不能为空')
      return
    }
    if (!trimmedSystemPrompt) {
      setCharacterError('人设内容不能为空')
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
      setCharacterError('创建角色失败，请稍后重试')
    } finally {
      setIsSavingCreate(false)
    }
  }, [createName, createCharacterId, createSystemPrompt, importedAvatarFile, importedMetadataFields, switchPreset])

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
      setPersonaError('人设内容不能为空')
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
          setSystemPromptNotice(`此次修改将在下次重新启用『${presetSnapshotRef.current?.name ?? ''}』时生效。`)
        }
        setSystemPromptStep('idle')
      }
    } catch (err) {
      if (err instanceof DOMException && err.name === 'AbortError') return
      if (presetId !== presetSnapshotRef.current?.presetId) return
      setPersonaError('保存人设失败，请稍后重试')
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
      setPersonaError('模型名称不能为空')
      return
    }
    if (!useGlobalModel && !summarySameAsChat && !summaryModelName.trim()) {
      setPersonaError('摘要模型名称不能为空')
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
        if (typeof payload?.error === 'string') serverError = payload.error
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
          setModelOverrideNotice(`此次修改将在下次重新启用『${presetSnapshotRef.current?.name ?? ''}』时生效。`)
        }
        setModelOverrideStep('idle')
      }
    } catch (err) {
      if (err instanceof DOMException && err.name === 'AbortError') return
      if (presetId !== presetSnapshotRef.current?.presetId) return
      setPersonaError(serverError ?? '保存模型设置失败，请稍后重试')
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
        setAppearanceError('颜色/透明度保存失败，请稍后重试')
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
        setAppearanceError('形态切换失败，请稍后重试')
      })
      .finally(() => setIsSwitchingPortrait(false))
  }, [otherPortrait, onSwitched])

  const characterIdOptions = importedCardFields && createCharacterId && !characterIds.includes(createCharacterId)
    ? [{ value: createCharacterId, label: `（新导入）${createCharacterId}` }, ...characterIds.map(id => ({ value: id, label: id }))]
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
