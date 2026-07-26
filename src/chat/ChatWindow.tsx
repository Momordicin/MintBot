import React, { useCallback, useEffect, useRef, useState } from 'react'
import { MessageList } from './MessageList'
import { InputBar } from './InputBar'
import { MessageData } from './MessageBubble'
import { parseSSE } from './sse'
import './chat.css'

const CORE_URL = 'http://127.0.0.1:3000'
const DEFAULT_WALLPAPER_URL = `${CORE_URL}/wallpapers/bg.jpg`

interface PresetSnapshot {
  presetId: string
  name: string
  characterId: string
  modelType: string
  modelName: string
  wallpaperPath?: string
  systemPrompt: string
}

interface AppState {
  sessionId: string | null
  presetSnapshot: PresetSnapshot | null
  ollamaReady: boolean | null
  emotion: null
  embeddingQueue: null
}

interface PresetOption {
  presetId: string
  name: string
}

function wallpaperUrlFor(snapshot: PresetSnapshot | null): string {
  return snapshot?.wallpaperPath
    ? `${CORE_URL}/wallpapers/${encodeURIComponent(snapshot.wallpaperPath)}`
    : DEFAULT_WALLPAPER_URL
}

async function fetchAvatarUrl(characterId: string, signal?: AbortSignal): Promise<string | undefined> {
  try {
    const res = await fetch(`${CORE_URL}/characters/${encodeURIComponent(characterId)}/manifest.json`, { signal })
    if (!res.ok) return undefined

    const manifest: { avatar?: string } = await res.json()
    if (!manifest.avatar) return undefined

    return `${CORE_URL}/characters/${encodeURIComponent(characterId)}/${encodeURIComponent(manifest.avatar)}`
  } catch {
    return undefined
  }
}

export function ChatWindow() {
  const hasFetched = useRef(false)
  const [messages, setMessages] = useState<MessageData[]>([])
  const [isReplying, setIsReplying] = useState(false)
  const [appState, setAppState] = useState<AppState | null>(null)
  const [wallpaperUrl, setWallpaperUrl] = useState<string | null>(null)
  const [avatarUrl, setAvatarUrl] = useState<string | undefined>(undefined)
  const [presets, setPresets] = useState<PresetOption[]>([])
  const [isUploadingWallpaper, setIsUploadingWallpaper] = useState(false)
  // 回复进行中用户仍可继续发送新消息，同一时间可能有多个 /chat 请求在途，
  // 用 Set 而不是单一 ref，保证切换 preset 时能把所有仍在进行中的请求都中断掉
  const activeControllersRef = useRef<Set<AbortController>>(new Set())
  // 快速连续切换 preset 时，上一次切换还在途中的请求必须被中断，否则哪个请求先返回不确定，
  // 可能出现"其它信息已经是新 preset，但头像还是旧 preset"这种局部状态不一致
  const switchPresetControllerRef = useRef<AbortController | null>(null)
  // 壁纸上传自己独立的 controller，不与 switchPresetControllerRef 共用：两者取消方向不对称——
  // 切换 preset 应该能中断一次仍在进行中的壁纸上传（上传结果绑定的是旧 preset 上下文，
  // 切换后已不再适用），但反过来一次壁纸上传不应该去中断"正在进行中的 preset 切换"本身
  const wallpaperControllerRef = useRef<AbortController | null>(null)
  // 让 handleWallpaperPick 在系统文件选择框（非模态，用户可在此期间继续切换 preset）关闭后，
  // 能读到"点击选图按钮那一刻之后是否发生过 preset 切换"的最新值，而不是闭包捕获的旧 appState
  const appStateRef = useRef<AppState | null>(null)

  useEffect(() => {
    appStateRef.current = appState
  }, [appState])

  useEffect(() => {
    if (hasFetched.current) return
    hasFetched.current = true

    fetch(`${CORE_URL}/state`)
      .then(r => r.json())
      .then((state: AppState) => {
        // 视为"第 0 次切换"接入 switchPresetControllerRef：如果这次初始请求还没返回、
        // 用户就已经手动切换了 preset，switchPreset 开头会把这个 controller 一并 abort 掉，
        // 避免晚到的初始结果把已经切换好的新状态（appState/wallpaper/头像）悄悄覆盖回去。
        // 如果 switchPreset 在这次初始请求返回之前就已经开始（甚至已经跑完），
        // switchPresetControllerRef.current 会已经非 null（switchPreset 自己的 abort 此时扑空，
        // 因为它开始时这个 ref 还是 null）——这种情况下这次初始 /state 结果已经过期，直接放弃
        if (switchPresetControllerRef.current) return
        const controller = new AbortController()
        switchPresetControllerRef.current = controller

        setAppState(state)
        setWallpaperUrl(wallpaperUrlFor(state.presetSnapshot))
        if (state.presetSnapshot?.characterId) {
          fetchAvatarUrl(state.presetSnapshot.characterId, controller.signal).then(url => {
            if (controller.signal.aborted) return
            setAvatarUrl(url)
          })
        }
      })
      .catch(() => {
        addSystemMessage('无法连接核心服务，请确认服务已启动', true)
      })

    fetch(`${CORE_URL}/presets`)
      .then(r => r.json())
      .then((list: PresetOption[]) => setPresets(list))
      .catch(() => {
        // preset 列表拉取失败不影响主聊天流程，静默忽略即可
      })
  }, [])

  const switchPreset = useCallback(async (presetId: string) => {
    // 切换时中断所有仍在进行中的 /chat 请求（不止"最新一次"——回复进行中用户仍可继续发送
    // 新消息，可能同时有多个在途请求），避免任意一个旧请求的 SSE 流继续把 message_done
    // 推回来，追加到已经切换过去的新 preset 对话框里
    for (const controller of activeControllersRef.current) {
      controller.abort()
    }
    setIsReplying(false)

    switchPresetControllerRef.current?.abort()
    // 切换 preset 使任何仍绑定在旧 preset 上下文里的壁纸上传失效——见 wallpaperControllerRef 声明处注释
    wallpaperControllerRef.current?.abort()
    const controller = new AbortController()
    switchPresetControllerRef.current = controller
    setAvatarUrl(undefined)

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

      setAppState(state)
      setWallpaperUrl(wallpaperUrlFor(state.presetSnapshot))
      setMessages([])

      const nextAvatarUrl = state.presetSnapshot?.characterId
        ? await fetchAvatarUrl(state.presetSnapshot.characterId, controller.signal)
        : undefined
      if (controller.signal.aborted) return
      setAvatarUrl(nextAvatarUrl)
    } catch (err) {
      // AbortError 是被更新的一次切换取消掉的，不算切换失败，不展示错误气泡
      if (!(err instanceof DOMException && err.name === 'AbortError')) {
        addSystemMessage('切换角色失败，请稍后重试', true)
        // TODO(known limitation, 待做): 若这次失败恰好发生在挂载时初始 /state 请求还未返回、
        // 且已被本次切换判定为"过期"放弃的窗口期内，appState/wallpaperUrl/avatarUrl 会停留在
        // 初始空值——只有这条错误提示，没有 fallback 重新拉取 /state 补上状态。用户手动重新
        // 选择一次 preset 即可恢复，暂不处理。
      }
    }
  }, [])

  const handleWallpaperPick = useCallback(async () => {
    const presetId = appState?.presetSnapshot?.presetId
    if (!presetId) return
    // 系统文件选择框非模态，按钮本身又没有 disabled 态，连点会并发打开多个 dialog；
    // 用这个标记防止重入，配合下面按钮的 disabled 属性一起生效
    if (isUploadingWallpaper) return

    setIsUploadingWallpaper(true)
    try {
      // 这里捕获的 presetId 只代表点击那一刻的当前 preset，dialog resolve 之后必须
      // 重新核对（见下方 appStateRef 检查）
      const result = await window.electronAPI.selectWallpaperFile()
      if (!result) return

      // dialog 打开期间用户已经切换到了别的 preset：这次上传的上下文已经过期，
      // 静默放弃即可——用户当前实际所在的 preset 完全没受影响，不算失败
      if (appStateRef.current?.presetSnapshot?.presetId !== presetId) return

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

      setAppState(state)
      setWallpaperUrl(wallpaperUrlFor(state.presetSnapshot))
    } catch (err) {
      if (err instanceof DOMException && err.name === 'AbortError') return
      // Electron 的 ipcMain.handle 抛错经 IPC 传回渲染层时，message 可能被包一层前缀
      // （如 "Error invoking remote method ...: Error: file-too-large"），用 includes
      // 而非严格相等匹配，避免因包装格式而漏判
      if (err instanceof Error && err.message.includes('file-too-large')) {
        addSystemMessage('图片文件过大，请选择小于 10MB 的图片', true)
        return
      }
      addSystemMessage('更换壁纸失败，请稍后重试', true)
    } finally {
      setIsUploadingWallpaper(false)
    }
  }, [appState, isUploadingWallpaper])

  function addSystemMessage(content: string, isError = false) {
    setMessages(prev => [...prev, {
      id: Date.now().toString(),
      role: 'system' as const,
      content,
      createdAt: Date.now(),
      isError,
    }])
  }

  const sendMessage = useCallback(async (text: string) => {
    setMessages(prev => [...prev, {
      id: Date.now().toString(),
      role: 'user' as const,
      content: text,
      createdAt: Date.now(),
    }])
    setIsReplying(true)

    const controller = new AbortController()
    activeControllersRef.current.add(controller)

    try {
      const response = await fetch(`${CORE_URL}/chat`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ message: text }),
        signal: controller.signal,
      })

      if (!response.ok) {
        throw new Error(`HTTP ${response.status}`)
      }

      for await (const { event, data } of parseSSE(response)) {
        // abort() 只能拒绝掉"还没读完"的 reader.read()——如果完整的 SSE 事件已经读进了
        // parseSSE 生成器的本地缓冲区，只是这个循环还没来得及处理，abort 本身拦不住。
        // 这里显式检查 signal 状态，避免把过期的 message_done/system 事件应用到已经
        // 切换过去的新 preset 界面上
        if (controller.signal.aborted) break

        if (event === 'message_done') {
          const { text: replyText } = data as { messageId: string; text: string }
          setMessages(prev => [...prev, {
            id: Date.now().toString(),
            role: 'assistant' as const,
            content: replyText,
            createdAt: Date.now(),
          }])
        }

        if (event === 'system') {
          const { payload } = data as { type: string; payload: { message: string } }
          addSystemMessage(payload.message, true)
        }

        // emotion: Phase 2 处理
        // message_chunk: Phase 4 开放后处理
      }
    } catch (err) {
      // AbortError 是切换 preset 主动中断导致的，不算回复失败，不展示错误气泡
      if (!(err instanceof DOMException && err.name === 'AbortError')) {
        addSystemMessage('回复失败，请稍后重试', true)
      }
    } finally {
      activeControllersRef.current.delete(controller)
      setIsReplying(false)
    }
  }, [])

  const displayName = appState?.presetSnapshot?.name ?? '角色'

  return (
    <div
      className="chat-window"
      style={wallpaperUrl ? { backgroundImage: `url(${wallpaperUrl})` } : undefined}
    >
      {appState?.ollamaReady === false && (
        <div className="banner banner--warn">
          Ollama 未运行，请先启动 Ollama
        </div>
      )}

      {presets.length > 0 && (
        <div className="preset-switcher">
          <select
            value={appState?.presetSnapshot?.presetId ?? ''}
            onChange={e => switchPreset(e.target.value)}
          >
            {presets.map(p => (
              <option key={p.presetId} value={p.presetId}>{p.name}</option>
            ))}
          </select>
          <button
            className="wallpaper-btn"
            onClick={handleWallpaperPick}
            disabled={isUploadingWallpaper}
            title="更换壁纸"
          >
            {isUploadingWallpaper ? '更换中…' : '更换壁纸'}
          </button>
        </div>
      )}

      <div className="chat-area">
        <MessageList
          messages={messages}
          isReplying={isReplying}
          avatarUrl={avatarUrl}
          displayName={displayName}
        />
      </div>

      <div className="input-area">
        <InputBar onSend={sendMessage} />
      </div>
    </div>
  )
}
