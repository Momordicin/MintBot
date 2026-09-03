import React, { useCallback, useEffect, useRef, useState } from 'react'
import type { AppState, ModelConfig, PresetDisplayConfig, PresetSnapshot } from '../../shared/types/index.js'
import './settings.css'

const CORE_URL = 'http://127.0.0.1:3000'
// 与 services/core/session/displayConfig.ts 的 DEFAULT_DISPLAY_CONFIG 保持一致，
// 仅当 presetSnapshot.displayConfig 缺失（v7 之前创建的历史冻结快照）时用作控件初始值
const DEFAULT_DISPLAY_CONFIG: PresetDisplayConfig = { chatBgRgb: [15, 15, 20], chatBgOpacity: 0.65 }
const DISPLAY_CONFIG_DEBOUNCE_MS = 400

interface PresetOption {
  presetId: string
  name: string
}

// 人设编辑的完整流程有且只有一个当前所在的步骤，用一个判别式联合表达，避免用一组独立
// 布尔值时出现"同时为 true"的不可能状态
type SystemPromptStep = 'idle' | 'editing' | 'confirmingSave' | 'confirmingApply' | 'saving'

// 模型覆盖是"用哪个模型回答"的技术设置，不是"覆写人格"，因此比 SystemPromptStep 少一步：
// 没有 systemPrompt 那种带文案的 confirmingSave 步骤，点"保存"直接进入立即应用/下次生效的选择
type ModelOverrideStep = 'idle' | 'editing' | 'chooseApply' | 'saving'

function rgbToHex([r, g, b]: [number, number, number]): string {
  return `#${[r, g, b].map(n => n.toString(16).padStart(2, '0')).join('')}`
}

function hexToRgb(hex: string): [number, number, number] {
  const r = parseInt(hex.slice(1, 3), 16)
  const g = parseInt(hex.slice(3, 5), 16)
  const b = parseInt(hex.slice(5, 7), 16)
  return [r, g, b]
}

interface CharacterPanelProps {
  presetSnapshot: PresetSnapshot | null
  onSwitched: (state: AppState) => void
}

export function CharacterPanel({ presetSnapshot, onSwitched }: CharacterPanelProps) {
  const [presets, setPresets] = useState<PresetOption[]>([])
  const [isUploadingWallpaper, setIsUploadingWallpaper] = useState(false)
  const [errorMessage, setErrorMessage] = useState<string | null>(null)
  const [isRenaming, setIsRenaming] = useState(false)
  const [renameValue, setRenameValue] = useState('')
  const [isSavingRename, setIsSavingRename] = useState(false)
  // 创建入口：低风险单步动作（同改名），不需要人设编辑那套两段确认——填表单/提交/完成
  const [isCreating, setIsCreating] = useState(false)
  const [createName, setCreateName] = useState('')
  const [createCharacterId, setCreateCharacterId] = useState('')
  const [createSystemPrompt, setCreateSystemPrompt] = useState('')
  const [isSavingCreate, setIsSavingCreate] = useState(false)
  // 角色卡导入：复用上面同一套创建表单/handleCreateSave，只是把"用户逐字段填"换成
  // "从卡片解析结果预填"。这两块状态只在导入流程里被赋值，手动创建（handleCreateStart）
  // 全程不碰它们，值恒为 null
  const [isImportingCard, setIsImportingCard] = useState(false)
  const [isGeneratingSystemPrompt, setIsGeneratingSystemPrompt] = useState(false)
  const [importedCardFields, setImportedCardFields] = useState<{
    description: string
    personality: string
    scenario: string
    mesExample: string
    systemPromptRaw: string
  } | null>(null)
  // 仅当解析出的卡片是 PNG 内嵌（hasEmbeddedAvatar）时才有值；创建成功后用它触发一次
  // 尽力而为的头像上传（POST /characters/:characterId/avatar），失败不影响 preset 本身
  const [importedAvatarFile, setImportedAvatarFile] = useState<{ data: Uint8Array<ArrayBuffer>; filename: string } | null>(null)
  // tags/creator/creatorNotes/characterVersion 只写入角色包 manifest.json，不进 systemPrompt
  // （TDD §3.7 附「角色卡导入」字段映射表），因此单独一份状态、不与 importedCardFields
  // 合并——后者是要发给 /characters/import/generate 重新改写的结构化字段，这四个字段跟
  // "改写" 无关。JSON 卡片与 PNG 卡片都可能带有这四个字段，因此不像 importedAvatarFile
  // 那样只在 hasEmbeddedAvatar 时才有值
  const [importedMetadataFields, setImportedMetadataFields] = useState<{
    tags: string[]
    creator: string
    creatorNotes: string
    characterVersion: string
  } | null>(null)
  // 人设编辑：五个互斥步骤中始终只有一个在生效，见上方 SystemPromptStep 类型注释
  const [systemPromptStep, setSystemPromptStep] = useState<SystemPromptStep>('idle')
  const [systemPromptValue, setSystemPromptValue] = useState('')
  // "下次生效"保存成功后的一次性提示，跟 errorMessage 共用同一块内联展示位置（渲染处见下方）
  const [systemPromptNotice, setSystemPromptNotice] = useState<string | null>(null)
  // 模型覆盖：四个互斥步骤中始终只有一个在生效，见上方 ModelOverrideStep 类型注释
  const [modelOverrideStep, setModelOverrideStep] = useState<ModelOverrideStep>('idle')
  const [useGlobalModel, setUseGlobalModel] = useState(true)
  const [overrideModelType, setOverrideModelType] = useState<ModelConfig['type']>('anthropic')
  const [overrideModelName, setOverrideModelName] = useState('')
  // 同 systemPromptNotice 的"下次生效"一次性提示，各自独立不共用，避免两个不相关的动作
  // 互相覆盖对方的提示文案
  const [modelOverrideNotice, setModelOverrideNotice] = useState<string | null>(null)
  // 快速连续切换 preset 时，上一次切换还在途中的请求必须被中断，否则哪个请求先返回不确定
  const switchPresetControllerRef = useRef<AbortController | null>(null)
  // 壁纸上传自己独立的 controller，不与 switchPresetControllerRef 共用：两者取消方向不对称——
  // 切换 preset 应该能中断一次仍在进行中的壁纸上传，但反过来一次壁纸上传不应该去中断
  // "正在进行中的 preset 切换"本身
  const wallpaperControllerRef = useRef<AbortController | null>(null)
  // 改名是独立于切换/上传的动作，不需要与它们互相中断（不像 wallpaper↔switch 那组不对称关系）——
  // 仅在组件卸载时随其它两个 controller 一起被 abort
  const renameControllerRef = useRef<AbortController | null>(null)
  // 创建同样独立于其它动作，仅在组件卸载时随其余 controller 一起被 abort
  const createControllerRef = useRef<AbortController | null>(null)
  // 角色卡导入的解析请求与"模型辅助改写"请求各自独立，互不中断，仅在组件卸载时一起 abort
  // （与 createControllerRef 同样的独立性考量：这两步都没有防抖/自动重发概念）
  const importControllerRef = useRef<AbortController | null>(null)
  const generateControllerRef = useRef<AbortController | null>(null)
  // 头像上传与元数据合并都是创建成功后的尽力而为后续步骤（fire-and-forget，不 await、
  // 不阻塞/回滚已经成功的创建），但同其它请求一样仍需要在卸载时被 abort，避免残留请求
  // 在组件已卸载后继续跑——各自独立的 ref，不与上面几个互相中断，同 createControllerRef
  // 等的独立性考量
  const avatarUploadControllerRef = useRef<AbortController | null>(null)
  const metadataMergeControllerRef = useRef<AbortController | null>(null)
  // 人设编辑没有防抖/自动保存概念（每次发送都是用户显式点过两段确认之后的结果），
  // 因此只需要 abort-then-reissue + 卸载时 abort，不需要 displayConfig 那套"卸载时补发"逻辑
  const systemPromptControllerRef = useRef<AbortController | null>(null)
  // 模型覆盖同样没有防抖概念，独立于 systemPromptControllerRef——两个编辑区块互不中断对方
  const modelOverrideControllerRef = useRef<AbortController | null>(null)
  // 让 handleWallpaperPick 在系统文件选择框（非模态，用户可在此期间继续切换 preset）关闭后，
  // 能读到"点击选图按钮那一刻之后是否发生过 preset 切换"的最新值，而不是闭包捕获的旧 prop
  const presetSnapshotRef = useRef<PresetSnapshot | null>(presetSnapshot)
  // 颜色/透明度这一组控件的本地实时值，随拖动/选色即时更新，独立于 presetSnapshot 的
  // 只读展示，通过下面的防抖 PATCH 落库
  const [chatBgRgb, setChatBgRgb] = useState<[number, number, number]>(DEFAULT_DISPLAY_CONFIG.chatBgRgb)
  const [chatBgOpacity, setChatBgOpacity] = useState<number>(DEFAULT_DISPLAY_CONFIG.chatBgOpacity)
  // 与改名/壁纸同款 abort-then-reissue，但颜色/透明度共用同一个 controller——两者都是
  // 同一个 PATCH /presets/:presetId 端点、同一类低风险外观偏好，没有必要分两个 controller
  const displayConfigControllerRef = useRef<AbortController | null>(null)
  const displayConfigDebounceRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  // 防抖期间累积的待发送增量，连同发起编辑那一刻所在的 presetId 一起保存——避免定时器
  // 触发时才现读 presetSnapshotRef，如果这期间用户已经切换了 preset，会把这次编辑误发到
  // 新 preset 上；只发生变化的字段，不在这里补全另一个字段
  const pendingDisplayConfigRef = useRef<{ presetId: string; partial: Partial<PresetDisplayConfig> } | null>(null)

  useEffect(() => {
    presetSnapshotRef.current = presetSnapshot
  }, [presetSnapshot])

  // 切换到不同 preset 时，用新 preset 的存量值重新初始化控件，不带着上一个 preset 的
  // 编辑中的值——按 presetId（而非整个 presetSnapshot 对象引用）判断，因为改名/换壁纸/
  // 这里自己的显示设置 PATCH 成功后都会用一个新对象引用回调 onSwitched，但那些情况下
  // 并没有真的切换 preset，不应该打断另一个还没来得及发送的防抖编辑
  useEffect(() => {
    setChatBgRgb(presetSnapshot?.displayConfig?.chatBgRgb ?? DEFAULT_DISPLAY_CONFIG.chatBgRgb)
    setChatBgOpacity(presetSnapshot?.displayConfig?.chatBgOpacity ?? DEFAULT_DISPLAY_CONFIG.chatBgOpacity)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [presetSnapshot?.presetId])

  // 同上一个 effect 的理由：按 presetId（而非整个对象引用）判断，因为这个功能自己的保存
  // 成功后也会用新对象引用回调 onSwitched，但那不是真的切换了 preset，不应该打断确认流程；
  // 真的切换 preset 时则无条件放弃当前所在的任何步骤，回到 idle 并用新 preset 的
  // systemPrompt 重新填充只读展示
  useEffect(() => {
    setSystemPromptStep('idle')
    setSystemPromptValue(presetSnapshot?.systemPrompt ?? '')
    setSystemPromptNotice(null)
    // 模型覆盖区块跟人设区块同款理由：真的切换 preset 时无条件放弃当前步骤，回到 idle
    // 并用新 preset 的 modelType/modelName 重新填充只读展示/编辑态初始值
    setModelOverrideStep('idle')
    setUseGlobalModel(presetSnapshot?.modelType === null)
    setOverrideModelType(presetSnapshot?.modelType ?? 'anthropic')
    setOverrideModelName(presetSnapshot?.modelName ?? '')
    setModelOverrideNotice(null)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [presetSnapshot?.presetId])

  // 这个面板会随设置窗口的 tab 切换被卸载/重新挂载（不像原来常驻的聊天窗口）——卸载时若
  // 有仍在进行中的切换/上传，必须主动 abort，否则重新挂载后的新实例拿到的是全新的、值为
  // null 的 ref，无法感知/中断旧实例遗留的在途请求，导致"哪个响应生效"重新变得不确定
  useEffect(() => {
    return () => {
      switchPresetControllerRef.current?.abort()
      wallpaperControllerRef.current?.abort()
      renameControllerRef.current?.abort()
      createControllerRef.current?.abort()
      displayConfigControllerRef.current?.abort()
      systemPromptControllerRef.current?.abort()
      modelOverrideControllerRef.current?.abort()
      importControllerRef.current?.abort()
      generateControllerRef.current?.abort()
      avatarUploadControllerRef.current?.abort()
      metadataMergeControllerRef.current?.abort()

      // 防抖定时器还没到、组件就被卸载：待发的最后一次颜色/透明度编辑不能被静默丢弃，
      // 在这里同步补发一次。组件已经卸载，不需要等待响应也不需要 onSwitched
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
          // fire-and-forget：组件已卸载，失败无处展示，也没有重试的必要
        })
      }
    }
  }, [])

  useEffect(() => {
    fetch(`${CORE_URL}/presets`)
      .then(r => r.json())
      .then((list: PresetOption[]) => setPresets(list))
      .catch(() => {
        // preset 列表拉取失败不影响本面板其它功能，静默忽略即可
      })
  }, [])

  const switchPreset = useCallback(async (presetId: string) => {
    switchPresetControllerRef.current?.abort()
    // 切换 preset 使任何仍绑定在旧 preset 上下文里的壁纸上传失效——见 wallpaperControllerRef 声明处注释
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
      // AbortError 是被更新的一次切换取消掉的，不算切换失败，不展示错误提示
      if (!(err instanceof DOMException && err.name === 'AbortError')) {
        setErrorMessage('切换角色失败，请稍后重试')
      }
    }
  }, [onSwitched])

  const handleWallpaperPick = useCallback(async () => {
    const presetId = presetSnapshotRef.current?.presetId
    if (!presetId) return
    // 系统文件选择框非模态，按钮本身又没有 disabled 态，连点会并发打开多个 dialog；
    // 用这个标记防止重入，配合下面按钮的 disabled 属性一起生效
    if (isUploadingWallpaper) return

    setIsUploadingWallpaper(true)
    setErrorMessage(null)
    try {
      // 这里捕获的 presetId 只代表点击那一刻的当前 preset，dialog resolve 之后必须
      // 重新核对（见下方 presetSnapshotRef 检查）
      const result = await window.electronAPI.selectWallpaperFile()
      if (!result) return

      // dialog 打开期间用户已经切换到了别的 preset：这次上传的上下文已经过期，
      // 静默放弃即可——用户当前实际所在的 preset 完全没受影响，不算失败
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
      // Electron 的 ipcMain.handle 抛错经 IPC 传回渲染层时，message 可能被包一层前缀
      // （如 "Error invoking remote method ...: Error: file-too-large"），用 includes
      // 而非严格相等匹配，避免因包装格式而漏判
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
      // 客户端校验，不发请求
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

      // 改名请求和切换 preset 是两个独立的、互不 abort 的请求（见上方设计说明），意味着
      // 这次改名的响应可能在用户已经切到别的 preset 之后才姗姗来迟地返回——这次响应里的
      // presetSnapshot 是发起改名那一刻、旧 preset 的状态，如果这时候直接 onSwitched(state)，
      // 会把已经切换过去的新 preset 界面悄悄冲回旧的。只有当前仍然停留在被改名的这个 preset
      // 上时，才应用这次响应
      if (state.presetSnapshot?.presetId === presetSnapshotRef.current?.presetId) {
        onSwitched(state)
      }
      // GET /presets 只在挂载时拉取一次，之后不会被任何东西自动刷新，这里本地 patch 一下
      // 让下拉框的选项文字立即同步，不必等一次全量重新拉取——这一步跟上面是否切换过 preset
      // 无关，改名操作本身对目标 preset 是有效的，下拉框里那一项的名字理应更新
      setPresets(prev => prev.map(p => (p.presetId === presetId ? { ...p, name: trimmedName } : p)))
      setIsRenaming(false)
    } catch (err) {
      // AbortError 由更晚一次的改名请求触发，不算失败，不展示错误提示
      if (err instanceof DOMException && err.name === 'AbortError') return
      // 保留输入内容、停留在编辑态，让用户可以直接重试而不用重新输入
      setErrorMessage('重命名失败，请稍后重试')
    } finally {
      setIsSavingRename(false)
    }
  }, [renameValue, onSwitched])

  const handleCreateStart = useCallback(() => {
    setCreateName('')
    setCreateCharacterId('')
    setCreateSystemPrompt('')
    // 手动创建与导入流程共用同一张表单：显式清空上一次可能残留的导入态，
    // 避免手动创建误触发"模型辅助改写"按钮或误上传上一次导入的头像
    setImportedCardFields(null)
    setImportedAvatarFile(null)
    setImportedMetadataFields(null)
    setErrorMessage(null)
    setIsCreating(true)
  }, [])

  const handleCreateCancel = useCallback(() => {
    setIsCreating(false)
    setImportedCardFields(null)
    setImportedAvatarFile(null)
    setImportedMetadataFields(null)
    setErrorMessage(null)
  }, [])

  const handleImportCardPick = useCallback(async () => {
    // 系统文件选择框非模态，按钮本身又没有 disabled 态之外的重入防护，用这个标记防重入。
    // 同一个标记也用来在此期间禁用"创建角色"入口（见渲染处 disabled={isImportingCard}），
    // 防止用户在解析结果返回前开始手动创建、随后被这里姗姗来迟地覆盖已手打的表单内容
    if (isImportingCard) return

    setIsImportingCard(true)
    setErrorMessage(null)
    try {
      const result = await window.electronAPI.selectCharacterCardFile()
      if (!result) return // 用户取消选择，不算失败

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

      // 预填同一张创建表单，用户接下来的编辑/提交路径与手动创建完全一致（handleCreateSave）
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
      // 只有 PNG 内嵌卡片才带头像候选；非 PNG 来源（V1/V2 纯 JSON）没有可保存的图片
      setImportedAvatarFile(parsed.hasEmbeddedAvatar ? result : null)
      // tags/creator/creatorNotes/characterVersion：JSON 卡片与 PNG 卡片都可能带有，
      // 不像头像候选那样只在 PNG 来源时才有值
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

      // 简单的可撤销文本替换：直接覆盖文本框当前内容，不是新增一步确认
      setCreateSystemPrompt(systemPrompt)
    } catch (err) {
      if (err instanceof DOMException && err.name === 'AbortError') return
      // 失败时保留文本框里已有的内容（手工模板结果或上一次改写结果），不清空、不阻塞创建
      setErrorMessage('模型辅助改写失败，请稍后重试')
    } finally {
      setIsGeneratingSystemPrompt(false)
    }
  }, [importedCardFields, isGeneratingSystemPrompt])

  const handleCreateSave = useCallback(async () => {
    const trimmedName = createName.trim()
    const trimmedCharacterId = createCharacterId.trim()
    const trimmedSystemPrompt = createSystemPrompt.trim()
    // 客户端校验，不发请求——与后端 POST /presets 的校验顺序/规则一致，避免为客户端能
    // 拦下的错误多绕一次网络往返
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

      // 与 handleRenameSave 同款本地 patch：下拉框选项立即出现新创建的角色，不必等一次
      // 全量重新拉取 GET /presets
      setPresets(prev => [...prev, { presetId, name }])
      setIsCreating(false)

      // 角色卡导入的可选后续步骤：仅当解析出的卡片带头像候选（PNG 内嵌）时才触发，
      // 尽力而为、fire-and-forget——失败不影响已经创建成功的 preset 本身，不重试不提示，
      // 因此故意不 await 这次 fetch
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
          // 同上：preset 已创建成功，头像保存失败无处展示，也没有重试的必要
        })
      }
      // 同上：角色卡导入的另一个可选后续步骤，每次导入创建都触发（不像头像候选那样只在
      // PNG 来源时才有值）——tags/creator/creatorNotes/characterVersion 写入 manifest.json，
      // 失败同样不影响已经创建成功的 preset 本身
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
          // 同上：preset 已创建成功，元数据保存失败无处展示，也没有重试的必要
        })
      }
      setImportedCardFields(null)
      setImportedAvatarFile(null)
      setImportedMetadataFields(null)

      // 复用既有的完整切换流程（含 onSwitched 回调），不重复实现同一套逻辑
      void switchPreset(presetId)
    } catch (err) {
      // AbortError 由更晚一次创建请求（理论上不会发生，创建没有防抖/自动重发）或组件卸载触发
      if (err instanceof DOMException && err.name === 'AbortError') return
      // 保留输入内容、停留在表单里，让用户可以直接重试而不用重新输入（同 handleRenameSave 的失败处理）
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
    // 丢弃这次输入，回 idle——下次点"编辑"会重新从 presetSnapshotRef 填充
    setSystemPromptStep('idle')
    setErrorMessage(null)
  }, [])

  const handleSystemPromptSaveClick = useCallback(() => {
    if (!systemPromptValue.trim()) {
      // 客户端校验，不进入确认流程，不发请求
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
    if (!trimmedValue) return // 已经在 handleSystemPromptSaveClick 校验过，这里不应该发生

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

      // 同 handleRenameSave 的一致性检查：响应姗姗来迟、期间用户已经切换到别的 preset 时，
      // 不应用这次响应，也不展示属于旧 preset 的一次性提示（切换本身已经由上面的 reseed
      // effect 把这个面板重置回 idle 了）
      if (state.presetSnapshot?.presetId === presetSnapshotRef.current?.presetId) {
        onSwitched(state)
        if (!applyNow) {
          setSystemPromptNotice(`此次修改将在下次重新启用『${presetSnapshotRef.current?.name ?? ''}』时生效。`)
        }
        setSystemPromptStep('idle')
      }
    } catch (err) {
      // AbortError 由更晚一次的保存请求触发，不算失败，不展示错误提示
      if (err instanceof DOMException && err.name === 'AbortError') return
      // 同上面成功分支一致的一致性检查：请求失败姗姗来迟、期间用户已经切换到别的 preset 时，
      // 这个错误跟当前显示的 preset 无关（reseed effect 早已把面板重置到新 preset 的状态），
      // 不应该把面板从新 preset 的状态里拽回 editing
      if (presetId !== presetSnapshotRef.current?.presetId) return
      // 保留输入内容、回到 editing（不是 confirmingSave/confirmingApply）——不记住之前
      // 选过哪个确认，重试要重新走一遍两段确认，同 handleRenameSave 的失败处理
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
    // 丢弃这次输入，回 idle——下次点"编辑"会重新从 presetSnapshotRef 填充
    setModelOverrideStep('idle')
    setErrorMessage(null)
  }, [])

  const handleModelOverrideSaveClick = useCallback(() => {
    if (!useGlobalModel && !overrideModelName.trim()) {
      // 客户端校验，不进入立即应用/下次生效的选择，不发请求
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
    if (!useGlobalModel && !trimmedModelName) return // 已经在 handleModelOverrideSaveClick 校验过，这里不应该发生

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

      // 同 handleRenameSave/handleSystemPromptSend 的一致性检查：响应姗姗来迟、期间用户
      // 已经切换到别的 preset 时，不应用这次响应
      if (state.presetSnapshot?.presetId === presetSnapshotRef.current?.presetId) {
        onSwitched(state)
        if (!applyNow) {
          setModelOverrideNotice(`此次修改将在下次重新启用『${presetSnapshotRef.current?.name ?? ''}』时生效。`)
        }
        setModelOverrideStep('idle')
      }
    } catch (err) {
      // AbortError 由更晚一次的保存请求触发，不算失败，不展示错误提示
      if (err instanceof DOMException && err.name === 'AbortError') return
      // 同上面成功分支一致的一致性检查：请求失败姗姗来迟、期间用户已经切换到别的 preset 时，
      // 这个错误跟当前显示的 preset 无关，不应该把面板从新 preset 的状态里拽回 editing
      if (presetId !== presetSnapshotRef.current?.presetId) return
      // 保留输入内容、回到 editing（不是 chooseApply）——重试要重新选一次立即应用/下次生效
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
        // 同 handleRenameSave 那类竞态（防抖保存的响应可能在用户已经切到别的 preset
        // 之后才姗姗来迟地返回），只有仍停留在被改的这个 preset 上时才应用
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

    // 同一防抖窗口内先后改了颜色又改透明度（或反过来）时合并成一次 PATCH；presetId 不同
    // 说明上一个待发变更属于另一个 preset（理论上不该发生，因为下面的重新初始化 effect
    // 已经按 presetId 切换过控件了），保险起见不跨 preset 合并
    const prevPending = pendingDisplayConfigRef.current
    pendingDisplayConfigRef.current = {
      presetId,
      partial: prevPending?.presetId === presetId ? { ...prevPending.partial, ...partial } : partial,
    }

    if (displayConfigDebounceRef.current) clearTimeout(displayConfigDebounceRef.current)
    displayConfigDebounceRef.current = setTimeout(flushPendingDisplayConfig, DISPLAY_CONFIG_DEBOUNCE_MS)
  }, [flushPendingDisplayConfig])

  const handleColorChange = useCallback((e: React.ChangeEvent<HTMLInputElement>) => {
    const rgb = hexToRgb(e.target.value)
    setChatBgRgb(rgb)
    scheduleDisplayConfigChange({ chatBgRgb: rgb })
  }, [scheduleDisplayConfigChange])

  const handleOpacityChange = useCallback((e: React.ChangeEvent<HTMLInputElement>) => {
    const opacity = Number(e.target.value)
    setChatBgOpacity(opacity)
    scheduleDisplayConfigChange({ chatBgOpacity: opacity })
  }, [scheduleDisplayConfigChange])

  return (
    <div className="character-panel">
      {/* 创建入口：不像下面几块一样套 presets.length > 0 的门——preset 列表为空（全新安装，
          或本功能本身让这个状态首次可达）时，这一行连同下方的空态提示是本面板唯一渲染的内容，
          用户必须能从这里创建出第一个 preset */}
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
          // 文件选择框（导入角色卡）非模态，disabled 防止用户在解析结果尚未返回时开始手动
          // 创建、随后被姗姗来迟的解析结果覆盖已经手打的表单内容——见 handleImportCardPick
          // 顶部注释与 isImportingCard 声明处注释
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
          <input
            className="character-panel__rename-input"
            value={createCharacterId}
            onChange={e => setCreateCharacterId(e.target.value)}
            placeholder="对应 assets/characters/ 下的文件夹名"
            disabled={isSavingCreate}
          />
          <textarea
            className="character-panel__persona-textarea"
            value={createSystemPrompt}
            onChange={e => setCreateSystemPrompt(e.target.value)}
            placeholder="人设正文"
            disabled={isSavingCreate}
          />
          {/* 仅导入流程可见：手动创建没有可供模型改写的结构化字段来源 */}
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
          <label className="character-panel__display-label" title="聊天区域背景叠色">
            背景颜色
            <input
              className="character-panel__color-input"
              type="color"
              value={rgbToHex(chatBgRgb)}
              onChange={handleColorChange}
            />
          </label>
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
                    onChange={e => setOverrideModelType(e.target.value as ModelConfig['type'])}
                  >
                    <option value="anthropic">Anthropic</option>
                    <option value="openai">OpenAI</option>
                    <option value="ollama">Ollama</option>
                  </select>
                  <input
                    className="character-panel__rename-input"
                    value={overrideModelName}
                    onChange={e => setOverrideModelName(e.target.value)}
                    placeholder="模型名称"
                  />
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
