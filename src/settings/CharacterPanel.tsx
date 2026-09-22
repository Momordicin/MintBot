import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { AppState, ModelConfig, PresetDisplayConfig, PresetSnapshot } from '../../shared/types/index.js'
import { hexToRgb, percentToTintStrength, rgbToHex, tintStrengthToPercent } from './themeControls.js'
import { deriveTheme } from '../chat/theme.js'
import { resolveThemeMode, themeCssVars } from '../chat/themeVars.js'
import { usePrefersDark } from '../usePrefersDark.js'
import './settings.css'

const CORE_URL = 'http://127.0.0.1:3000'
const DEFAULT_WALLPAPER_URL = `${CORE_URL}/wallpapers/bg.jpg`
const DEFAULT_DISPLAY_CONFIG: PresetDisplayConfig = {
  chatBgRgb: [15, 15, 20],
  chatBgOpacity: 0.65,
  themeMode: 'auto',
  accentRgb: [0, 122, 255],
  tintStrength: 0,
}
const DISPLAY_CONFIG_DEBOUNCE_MS = 400

interface PresetOption {
  presetId: string
  name: string
}

type SystemPromptStep = 'idle' | 'editing' | 'confirmingSave' | 'confirmingApply' | 'saving'

type ModelOverrideStep = 'idle' | 'editing' | 'chooseApply' | 'saving'

interface CharacterPanelProps {
  presetSnapshot: PresetSnapshot | null
  onSwitched: (state: AppState) => void
}

export function CharacterPanel({ presetSnapshot, onSwitched }: CharacterPanelProps) {
  const [presets, setPresets] = useState<PresetOption[]>([])
  const [characterIds, setCharacterIds] = useState<string[]>([])
  const [isUploadingWallpaper, setIsUploadingWallpaper] = useState(false)
  const [errorMessage, setErrorMessage] = useState<string | null>(null)
  const [isRenaming, setIsRenaming] = useState(false)
  const [renameValue, setRenameValue] = useState('')
  const [isSavingRename, setIsSavingRename] = useState(false)
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
  const [modelNameOptions, setModelNameOptions] = useState<string[]>([])
  const [isLoadingModelNames, setIsLoadingModelNames] = useState(false)
  const [modelOverrideNotice, setModelOverrideNotice] = useState<string | null>(null)
  const switchPresetControllerRef = useRef<AbortController | null>(null)
  const wallpaperControllerRef = useRef<AbortController | null>(null)
  const renameControllerRef = useRef<AbortController | null>(null)
  const createControllerRef = useRef<AbortController | null>(null)
  const importControllerRef = useRef<AbortController | null>(null)
  const generateControllerRef = useRef<AbortController | null>(null)
  const avatarUploadControllerRef = useRef<AbortController | null>(null)
  const metadataMergeControllerRef = useRef<AbortController | null>(null)
  const systemPromptControllerRef = useRef<AbortController | null>(null)
  const modelOverrideControllerRef = useRef<AbortController | null>(null)
  const modelNameOptionsControllerRef = useRef<AbortController | null>(null)
  const presetSnapshotRef = useRef<PresetSnapshot | null>(presetSnapshot)
  const [chatBgOpacity, setChatBgOpacity] = useState<number>(DEFAULT_DISPLAY_CONFIG.chatBgOpacity)
  const [themeMode, setThemeMode] = useState<PresetDisplayConfig['themeMode']>(DEFAULT_DISPLAY_CONFIG.themeMode)
  const [accentRgb, setAccentRgb] = useState<[number, number, number]>(DEFAULT_DISPLAY_CONFIG.accentRgb)
  const [tintStrength, setTintStrength] = useState<number>(DEFAULT_DISPLAY_CONFIG.tintStrength)
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
    setChatBgOpacity(presetSnapshot?.displayConfig?.chatBgOpacity ?? DEFAULT_DISPLAY_CONFIG.chatBgOpacity)
    setThemeMode(presetSnapshot?.displayConfig?.themeMode ?? DEFAULT_DISPLAY_CONFIG.themeMode)
    setAccentRgb(presetSnapshot?.displayConfig?.accentRgb ?? DEFAULT_DISPLAY_CONFIG.accentRgb)
    setTintStrength(presetSnapshot?.displayConfig?.tintStrength ?? DEFAULT_DISPLAY_CONFIG.tintStrength)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [presetSnapshot?.presetId])

  useEffect(() => {
    setSystemPromptStep('idle')
    setSystemPromptValue(presetSnapshot?.systemPrompt ?? '')
    setSystemPromptNotice(null)
    setModelOverrideStep('idle')
    setUseGlobalModel(presetSnapshot?.modelType === null)
    setOverrideModelType(presetSnapshot?.modelType ?? 'anthropic')
    setOverrideModelName(presetSnapshot?.modelName ?? '')
    setModelOverrideNotice(null)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [presetSnapshot?.presetId])

  useEffect(() => {
    return () => {
      switchPresetControllerRef.current?.abort()
      wallpaperControllerRef.current?.abort()
      renameControllerRef.current?.abort()
      createControllerRef.current?.abort()
      displayConfigControllerRef.current?.abort()
      systemPromptControllerRef.current?.abort()
      modelOverrideControllerRef.current?.abort()
      modelNameOptionsControllerRef.current?.abort()
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
        setErrorMessage('角色文件夹列表加载失败，无法创建新角色，请检查核心服务后重试')
      })
  }, [])

  useEffect(() => {
    modelNameOptionsControllerRef.current?.abort()
    const controller = new AbortController()
    modelNameOptionsControllerRef.current = controller
    setModelNameOptions([])
    setIsLoadingModelNames(true)

    fetch(`${CORE_URL}/models?type=${overrideModelType}`, { signal: controller.signal })
      .then(r => {
        if (!r.ok) throw new Error(`HTTP ${r.status}`)
        return r.json()
      })
      .then((body: { models: string[] }) => {
        if (controller.signal.aborted) return
        setModelNameOptions(body.models)
        setIsLoadingModelNames(false)
      })
      .catch(err => {
        if (err instanceof DOMException && err.name === 'AbortError') return
        setIsLoadingModelNames(false)
      })
  }, [overrideModelType])

  const switchPreset = useCallback(async (presetId: string) => {
    switchPresetControllerRef.current?.abort()
    wallpaperControllerRef.current?.abort()
    const controller = new AbortController()
    switchPresetControllerRef.current = controller
    setErrorMessage(null)

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
        setErrorMessage('切换角色失败，请稍后重试')
      }
    }
  }, [onSwitched])

  const handleWallpaperPick = useCallback(async () => {
    const presetId = presetSnapshotRef.current?.presetId
    if (!presetId) return
    if (isUploadingWallpaper) return

    setIsUploadingWallpaper(true)
    setErrorMessage(null)
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
        setErrorMessage('图片文件过大，请选择小于 10MB 的图片')
        return
      }
      setErrorMessage('更换壁纸失败，请稍后重试')
    } finally {
      setIsUploadingWallpaper(false)
    }
  }, [isUploadingWallpaper, onSwitched])

  const handleRenameStart = useCallback(() => {
    setRenameValue(presetSnapshotRef.current?.name ?? '')
    setErrorMessage(null)
    setIsRenaming(true)
  }, [])

  const handleRenameCancel = useCallback(() => {
    setIsRenaming(false)
    setErrorMessage(null)
  }, [])

  const handleRenameSave = useCallback(async () => {
    const presetId = presetSnapshotRef.current?.presetId
    if (!presetId) return

    const trimmedName = renameValue.trim()
    if (!trimmedName) {
      setErrorMessage('名称不能为空')
      return
    }

    renameControllerRef.current?.abort()
    const controller = new AbortController()
    renameControllerRef.current = controller
    setIsSavingRename(true)
    setErrorMessage(null)

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
      setErrorMessage('重命名失败，请稍后重试')
    } finally {
      setIsSavingRename(false)
    }
  }, [renameValue, onSwitched])

  const handleCreateStart = useCallback(() => {
    setCreateName('')
    setCreateCharacterId(characterIds[0] ?? '')
    setCreateSystemPrompt('')
    setImportedCardFields(null)
    setImportedAvatarFile(null)
    setImportedMetadataFields(null)
    setErrorMessage(null)
    setIsCreating(true)
  }, [characterIds])

  const handleCreateCancel = useCallback(() => {
    setIsCreating(false)
    setImportedCardFields(null)
    setImportedAvatarFile(null)
    setImportedMetadataFields(null)
    setErrorMessage(null)
  }, [])

  const handleImportCardPick = useCallback(async () => {
    if (isImportingCard) return

    setIsImportingCard(true)
    setErrorMessage(null)
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
        setErrorMessage('角色卡文件过大，请选择小于 5MB 的文件')
        return
      }
      setErrorMessage(err instanceof Error && err.message ? err.message : '导入角色卡失败，请稍后重试')
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
    setErrorMessage(null)

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
      setErrorMessage('模型辅助改写失败，请稍后重试')
    } finally {
      setIsGeneratingSystemPrompt(false)
    }
  }, [importedCardFields, isGeneratingSystemPrompt])

  const handleCreateSave = useCallback(async () => {
    const trimmedName = createName.trim()
    const trimmedCharacterId = createCharacterId.trim()
    const trimmedSystemPrompt = createSystemPrompt.trim()
    if (!trimmedName) {
      setErrorMessage('名称不能为空')
      return
    }
    if (!trimmedCharacterId) {
      setErrorMessage('角色包 ID 不能为空')
      return
    }
    if (!trimmedSystemPrompt) {
      setErrorMessage('人设内容不能为空')
      return
    }

    createControllerRef.current?.abort()
    const controller = new AbortController()
    createControllerRef.current = controller
    setIsSavingCreate(true)
    setErrorMessage(null)

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
      setErrorMessage('创建角色失败，请稍后重试')
    } finally {
      setIsSavingCreate(false)
    }
  }, [createName, createCharacterId, createSystemPrompt, importedAvatarFile, importedMetadataFields, switchPreset])

  const handleSystemPromptEditStart = useCallback(() => {
    setSystemPromptValue(presetSnapshotRef.current?.systemPrompt ?? '')
    setErrorMessage(null)
    setSystemPromptNotice(null)
    setSystemPromptStep('editing')
  }, [])

  const handleSystemPromptEditCancel = useCallback(() => {
    setSystemPromptStep('idle')
    setErrorMessage(null)
  }, [])

  const handleSystemPromptSaveClick = useCallback(() => {
    if (!systemPromptValue.trim()) {
      setErrorMessage('人设内容不能为空')
      return
    }
    setErrorMessage(null)
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
    setErrorMessage(null)

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
      setErrorMessage('保存人设失败，请稍后重试')
      setSystemPromptStep('editing')
    }
  }, [systemPromptValue, onSwitched])

  const handleModelOverrideEditStart = useCallback(() => {
    setUseGlobalModel(presetSnapshotRef.current?.modelType === null)
    setOverrideModelType(presetSnapshotRef.current?.modelType ?? 'anthropic')
    setOverrideModelName(presetSnapshotRef.current?.modelName ?? '')
    setErrorMessage(null)
    setModelOverrideNotice(null)
    setModelOverrideStep('editing')
  }, [])

  const handleModelOverrideEditCancel = useCallback(() => {
    setModelOverrideStep('idle')
    setErrorMessage(null)
  }, [])

  const handleModelOverrideSaveClick = useCallback(() => {
    if (!useGlobalModel && !overrideModelName.trim()) {
      setErrorMessage('模型名称不能为空')
      return
    }
    setErrorMessage(null)
    setModelOverrideStep('chooseApply')
  }, [useGlobalModel, overrideModelName])

  const handleModelOverrideChooseApplyCancel = useCallback(() => {
    setModelOverrideStep('editing')
  }, [])

  const handleModelOverrideSend = useCallback(async (applyNow: boolean) => {
    const presetId = presetSnapshotRef.current?.presetId
    if (!presetId) return

    const modelType = useGlobalModel ? null : overrideModelType
    const trimmedModelName = useGlobalModel ? null : overrideModelName.trim()
    if (!useGlobalModel && !trimmedModelName) return 

    modelOverrideControllerRef.current?.abort()
    const controller = new AbortController()
    modelOverrideControllerRef.current = controller
    setModelOverrideStep('saving')
    setErrorMessage(null)

    try {
      const response = await fetch(`${CORE_URL}/presets/${encodeURIComponent(presetId)}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ modelType, modelName: trimmedModelName, applyNow }),
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
          setModelOverrideNotice(`此次修改将在下次重新启用『${presetSnapshotRef.current?.name ?? ''}』时生效。`)
        }
        setModelOverrideStep('idle')
      }
    } catch (err) {
      if (err instanceof DOMException && err.name === 'AbortError') return
      if (presetId !== presetSnapshotRef.current?.presetId) return
      setErrorMessage('保存模型设置失败，请稍后重试')
      setModelOverrideStep('editing')
    }
  }, [useGlobalModel, overrideModelType, overrideModelName, onSwitched])

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
        setErrorMessage('颜色/透明度保存失败，请稍后重试')
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

  const handleOpacityChange = useCallback((e: React.ChangeEvent<HTMLInputElement>) => {
    const opacity = Number(e.target.value)
    setChatBgOpacity(opacity)
    scheduleDisplayConfigChange({ chatBgOpacity: opacity })
  }, [scheduleDisplayConfigChange])

  const handleNoColorClick = useCallback(() => {
    setChatBgOpacity(0)
    scheduleDisplayConfigChange({ chatBgOpacity: 0 })
  }, [scheduleDisplayConfigChange])

  const handleThemeModeChange = useCallback((e: React.ChangeEvent<HTMLSelectElement>) => {
    const mode = e.target.value as PresetDisplayConfig['themeMode']
    setThemeMode(mode)
    scheduleDisplayConfigChange({ themeMode: mode })
  }, [scheduleDisplayConfigChange])

  const handleAccentColorChange = useCallback((e: React.ChangeEvent<HTMLInputElement>) => {
    const rgb = hexToRgb(e.target.value)
    setAccentRgb(rgb)
    scheduleDisplayConfigChange({ accentRgb: rgb })
  }, [scheduleDisplayConfigChange])

  const handleTintChange = useCallback((e: React.ChangeEvent<HTMLInputElement>) => {
    const tint = percentToTintStrength(Number(e.target.value))
    setTintStrength(tint)
    scheduleDisplayConfigChange({ tintStrength: tint })
  }, [scheduleDisplayConfigChange])

  const handleResetTint = useCallback(() => {
    setTintStrength(0)
    scheduleDisplayConfigChange({ tintStrength: 0 })
  }, [scheduleDisplayConfigChange])

  const characterIdOptions = importedCardFields && createCharacterId && !characterIds.includes(createCharacterId)
    ? [{ value: createCharacterId, label: `（新导入）${createCharacterId}` }, ...characterIds.map(id => ({ value: id, label: id }))]
    : characterIds.map(id => ({ value: id, label: id }))

  const overrideModelNameOptions = overrideModelName && !modelNameOptions.includes(overrideModelName)
    ? [overrideModelName, ...modelNameOptions]
    : modelNameOptions

  return (
    <div className="character-panel">
      <div className="character-panel__row">
        {presets.length > 0 && (
          <select
            value={presetSnapshot?.presetId ?? ''}
            onChange={e => switchPreset(e.target.value)}
          >
            {presets.map(p => (
              <option key={p.presetId} value={p.presetId}>{p.name}</option>
            ))}
          </select>
        )}
        {presets.length > 0 && (
          isRenaming ? (
            <>
              <input
                className="character-panel__rename-input"
                value={renameValue}
                onChange={e => setRenameValue(e.target.value)}
                disabled={isSavingRename}
              />
              <button className="rename-btn" onClick={handleRenameCancel} disabled={isSavingRename}>
                取消
              </button>
              <button className="rename-btn" onClick={handleRenameSave} disabled={isSavingRename}>
                {isSavingRename ? '保存中…' : '保存'}
              </button>
            </>
          ) : (
            <button className="rename-btn" onClick={handleRenameStart} title="重命名当前角色">
              编辑
            </button>
          )
        )}
        {presets.length > 0 && (
          <button
            className="wallpaper-btn"
            onClick={handleWallpaperPick}
            disabled={isUploadingWallpaper}
            title="更换壁纸"
          >
            {isUploadingWallpaper ? '更换中…' : '更换壁纸'}
          </button>
        )}
        {!isCreating && (
          <button className="rename-btn" onClick={handleCreateStart} disabled={isImportingCard} title="创建新角色">
            创建角色
          </button>
        )}
        {!isCreating && (
          <button className="rename-btn" onClick={handleImportCardPick} disabled={isImportingCard} title="从 SillyTavern character card v2 导入">
            {isImportingCard ? '导入中…' : '导入角色卡'}
          </button>
        )}
      </div>
      {presets.length === 0 && !isCreating && (
        <div className="character-panel__hint">还没有角色，创建一个开始</div>
      )}
      {isCreating && (
        <div className="character-panel__create-form">
          <input
            className="character-panel__rename-input"
            value={createName}
            onChange={e => setCreateName(e.target.value)}
            placeholder="角色名称"
            disabled={isSavingCreate}
          />
          <select
            value={createCharacterId}
            onChange={e => setCreateCharacterId(e.target.value)}
            disabled={isSavingCreate}
          >
            {characterIdOptions.map(opt => (
              <option key={opt.value} value={opt.value}>{opt.label}</option>
            ))}
          </select>
          <textarea
            className="character-panel__persona-textarea"
            value={createSystemPrompt}
            onChange={e => setCreateSystemPrompt(e.target.value)}
            placeholder="人设正文"
            disabled={isSavingCreate}
          />
          {importedCardFields && (
            <button
              className="rename-btn"
              onClick={handleRegenerateSystemPrompt}
              disabled={isSavingCreate || isGeneratingSystemPrompt}
              title="用后台模型把角色卡字段改写成更连贯的人设正文"
            >
              {isGeneratingSystemPrompt ? '改写中…' : '使用模型辅助改写'}
            </button>
          )}
          <div className="character-panel__row">
            <button className="rename-btn" onClick={handleCreateCancel} disabled={isSavingCreate}>
              取消
            </button>
            <button className="rename-btn" onClick={handleCreateSave} disabled={isSavingCreate}>
              {isSavingCreate ? '创建中…' : '创建'}
            </button>
          </div>
        </div>
      )}
      {presets.length > 0 && (
        <div className="character-panel__row">
          <button
            type="button"
            className={`character-panel__no-color-btn${chatBgOpacity === 0 ? ' character-panel__no-color-btn--active' : ''}`}
            onClick={handleNoColorClick}
            title="无色（不透明度设为 0）"
            aria-label="无色"
            aria-pressed={chatBgOpacity === 0}
          />
          <label className="character-panel__display-label" title="聊天区域背景不透明度">
            不透明度
            <input
              className="character-panel__opacity-input"
              type="range"
              min={0}
              max={1}
              step={0.01}
              value={chatBgOpacity}
              onChange={handleOpacityChange}
            />
          </label>
        </div>
      )}
      {presets.length > 0 && (
        <div className="character-panel__row">
          <label className="character-panel__display-label" title="聊天窗口跟随日间/夜间，还是跟随系统外观">
            模式
            <select value={themeMode} onChange={handleThemeModeChange}>
              <option value="day">日间</option>
              <option value="night">夜间</option>
              <option value="auto">跟随系统</option>
            </select>
          </label>
          <label className="character-panel__display-label" title="主题强调色（唯一一个用户选的颜色，其余全部自动派生）">
            强调色
            <input
              className="character-panel__color-input"
              type="color"
              value={rgbToHex(accentRgb)}
              onChange={handleAccentColorChange}
            />
          </label>
        </div>
      )}
      {presets.length > 0 && (
        <div className="character-panel__row">
          <label className="character-panel__display-label" title="强调色向中性表面/文字染色的强度，0 = 基准配色">
            染色强度
            <input
              className="character-panel__opacity-input"
              type="range"
              min={0}
              max={100}
              step={1}
              value={tintStrengthToPercent(tintStrength)}
              onChange={handleTintChange}
            />
          </label>
          <button
            type="button"
            className="rename-btn"
            onClick={handleResetTint}
            disabled={tintStrength === 0}
            title="把染色强度重置为 0，恢复逐字节等于参考发布值的配色"
          >
            回到基准配色
          </button>
        </div>
      )}
      {presets.length > 0 && (
        <div className="character-panel__theme-preview-wrap">
          <div className="character-panel__theme-preview-label">
            主题预览
            {themeMode === 'auto' && (
              <span className="character-panel__theme-preview-resolved">
                （当前跟随系统解析为{previewResolvedMode === 'night' ? '夜间' : '日间'}）
              </span>
            )}
          </div>
          <div
            className="character-panel__theme-preview"
            style={{
              backgroundImage: `url(${previewWallpaperUrl})`,
              ...previewVars,
            } as React.CSSProperties}
          >
            <div className="character-panel__theme-preview-titlebar">
              {presetSnapshot?.name ?? '角色'}
            </div>
            <div className="character-panel__theme-preview-messages">
              <div className="character-panel__theme-preview-bubble character-panel__theme-preview-bubble--user">
                你好呀
              </div>
              <div className="character-panel__theme-preview-bubble character-panel__theme-preview-bubble--bot">
                嗯，在的
              </div>
              <div className="character-panel__theme-preview-timestamp">14:32</div>
            </div>
            <div className="character-panel__theme-preview-input">输入消息…</div>
          </div>
        </div>
      )}
      {presets.length > 0 && (
        <div className="character-panel__persona">
          <div className="character-panel__persona-label">人设</div>
          {systemPromptStep === 'idle' && (
            <>
              <div className="character-panel__persona-text">{presetSnapshot?.systemPrompt}</div>
              <button className="rename-btn" onClick={handleSystemPromptEditStart} title="编辑当前角色的人设">
                编辑
              </button>
            </>
          )}
          {systemPromptStep === 'editing' && (
            <>
              <textarea
                className="character-panel__persona-textarea"
                value={systemPromptValue}
                onChange={e => setSystemPromptValue(e.target.value)}
              />
              <div className="character-panel__row">
                <button className="rename-btn" onClick={handleSystemPromptEditCancel}>取消</button>
                <button className="rename-btn" onClick={handleSystemPromptSaveClick}>保存</button>
              </div>
            </>
          )}
          {systemPromptStep === 'confirmingSave' && (
            <div className="character-panel__persona-confirm">
              <div>确认要保存这次修改吗？这会覆写『{presetSnapshot?.name}』的人格设定。</div>
              <div className="character-panel__row">
                <button className="rename-btn" onClick={handleSystemPromptConfirmSaveCancel}>取消</button>
                <button className="rename-btn" onClick={handleSystemPromptConfirmSaveConfirm}>确认</button>
              </div>
            </div>
          )}
          {systemPromptStep === 'confirmingApply' && (
            <div className="character-panel__persona-confirm">
              <div>现在就应用，还是下次生效？</div>
              <div className="character-panel__row">
                <button className="rename-btn" onClick={handleSystemPromptConfirmApplyCancel}>取消</button>
                <button className="rename-btn" onClick={() => handleSystemPromptSend(false)}>下次生效</button>
                <button className="rename-btn" onClick={() => handleSystemPromptSend(true)}>立即应用</button>
              </div>
            </div>
          )}
          {systemPromptStep === 'saving' && (
            <div className="character-panel__persona-confirm">保存中…</div>
          )}
        </div>
      )}
      {presets.length > 0 && (
        <div className="character-panel__model">
          <div className="character-panel__model-label">模型</div>
          {modelOverrideStep === 'idle' && (
            <>
              <div className="character-panel__model-text">
                {presetSnapshot?.modelType === null
                  ? '使用全局默认模型'
                  : `${presetSnapshot?.modelType} / ${presetSnapshot?.modelName}`}
              </div>
              <button className="rename-btn" onClick={handleModelOverrideEditStart} title="编辑当前角色使用的模型">
                编辑
              </button>
            </>
          )}
          {modelOverrideStep === 'editing' && (
            <>
              <label className="character-panel__model-checkbox">
                <input
                  type="checkbox"
                  checked={useGlobalModel}
                  onChange={e => setUseGlobalModel(e.target.checked)}
                />
                使用全局默认模型
              </label>
              {!useGlobalModel && (
                <div className="character-panel__row">
                  <select
                    value={overrideModelType}
                    onChange={e => {
                      setOverrideModelType(e.target.value as ModelConfig['type'])
                      setOverrideModelName('')
                    }}
                  >
                    <option value="anthropic">Anthropic</option>
                    <option value="openai">OpenAI</option>
                    <option value="deepseek">DeepSeek</option>
                    <option value="ollama">Ollama</option>
                  </select>
                  <select
                    value={overrideModelName}
                    onChange={e => setOverrideModelName(e.target.value)}
                    disabled={overrideModelNameOptions.length === 0}
                  >
                    {overrideModelNameOptions.length === 0 ? (
                      <option value="" disabled>
                        {isLoadingModelNames
                          ? '模型列表加载中…'
                          : overrideModelType === 'ollama' ? 'Ollama 未运行或无可用模型' : '模型列表为空'}
                      </option>
                    ) : (
                      overrideModelNameOptions.map(name => (
                        <option key={name} value={name}>{name}</option>
                      ))
                    )}
                  </select>
                </div>
              )}
              <div className="character-panel__row">
                <button className="rename-btn" onClick={handleModelOverrideEditCancel}>取消</button>
                <button className="rename-btn" onClick={handleModelOverrideSaveClick}>保存</button>
              </div>
            </>
          )}
          {modelOverrideStep === 'chooseApply' && (
            <div className="character-panel__persona-confirm">
              <div>现在就应用，还是下次生效？</div>
              <div className="character-panel__row">
                <button className="rename-btn" onClick={handleModelOverrideChooseApplyCancel}>取消</button>
                <button className="rename-btn" onClick={() => handleModelOverrideSend(false)}>下次生效</button>
                <button className="rename-btn" onClick={() => handleModelOverrideSend(true)}>立即应用</button>
              </div>
            </div>
          )}
          {modelOverrideStep === 'saving' && (
            <div className="character-panel__persona-confirm">保存中…</div>
          )}
        </div>
      )}
      {errorMessage && <div className="character-panel__error">{errorMessage}</div>}
      {systemPromptNotice && <div className="character-panel__notice">{systemPromptNotice}</div>}
      {modelOverrideNotice && <div className="character-panel__notice">{modelOverrideNotice}</div>}
    </div>
  )
}
