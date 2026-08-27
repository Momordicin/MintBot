import React, { useCallback, useEffect, useRef, useState } from 'react'
import { MessageList } from './MessageList'
import { InputBar } from './InputBar'
import { MessageData } from './MessageBubble'
import { parseSSE } from './sse'
import type { AppState, PresetSnapshot } from '../../shared/types/index.js'
import './chat.css'

const CORE_URL = 'http://127.0.0.1:3000'
const DEFAULT_WALLPAPER_URL = `${CORE_URL}/wallpapers/bg.jpg`
// 打开窗口时只展示最近几条，上滑加载更多时每次拉一整页——具体数字是实现默认值，
// 不是 TDD 强制的具体规定
const INITIAL_HISTORY_LIMIT = 3
const LOAD_MORE_HISTORY_LIMIT = 20

// GET /messages 返回的历史消息 shape（对应 shared/types 里的 Message，渲染层不消费
// sessionId/embedded/summarized/trigger 等系统字段，只取展示需要的部分，与本文件其它
// DTO 一样按渲染层自己的约定本地重复定义，不引入 shared/types 依赖，见 DIV-009）
interface HistoryMessage {
  id: number
  role: 'user' | 'assistant' | 'system'
  content: string
  createdAt: number
}

interface MessagesPageResponse {
  messages: HistoryMessage[]
  hasMore: boolean
}

function toMessageData(m: HistoryMessage): MessageData {
  return { id: String(m.id), role: m.role, content: m.content, createdAt: m.createdAt }
}

function wallpaperUrlFor(snapshot: PresetSnapshot | null): string {
  return snapshot?.wallpaperPath
    ? `${CORE_URL}/wallpapers/${encodeURIComponent(snapshot.wallpaperPath)}`
    : DEFAULT_WALLPAPER_URL
}

// 三处独立刷新触发（轮询 / 窗口聚焦 / 发消息时机）共用的简单只读 fetch，不接入
// sessionSyncControllerRef 的 abort 机制——embeddingReady 是全局状态，不绑定某次
// session 同步的上下文，见任务范围说明
function fetchEmbeddingReady(): Promise<boolean | undefined> {
  return fetch(`${CORE_URL}/embedding-ready`)
    .then(r => r.json())
    .then((data: { embeddingReady: boolean }) => data.embeddingReady)
    .catch(() => undefined)
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
  // 保守默认值：挂载时的初始 /state 请求返回前，先当作"未就绪"处理（头像置灰），
  // 避免在真正尚未预热完成时短暂显示"已就绪"的误导状态
  const [embeddingReady, setEmbeddingReady] = useState<boolean>(false)
  const [wallpaperUrl, setWallpaperUrl] = useState<string | null>(null)
  const [avatarUrl, setAvatarUrl] = useState<string | undefined>(undefined)
  // 是否还有更多历史消息可加载，决定 MessageList 要不要在滑到顶部时触发 onLoadMore
  const [hasMoreHistory, setHasMoreHistory] = useState(false)
  // 每次初始历史加载完成后递增，触发 MessageList 一次性滚动到底部
  const [initialLoadSignal, setInitialLoadSignal] = useState(0)
  // 下一次"加载更多"的游标（当前已加载消息里最早一条的 id），不需要触发重渲染，用 ref 即可
  const oldestMessageIdRef = useRef<number | null>(null)
  // 防止同一时刻并发触发多次"加载更多"请求
  const isLoadingMoreRef = useRef(false)
  // 回复进行中用户仍可继续发送新消息，同一时间可能有多个 /chat 请求在途，用 Set 记录它们。
  // 注意：preset 切换搬到设置窗口后，这个 Set 已经没有任何代码会在切换时遍历它逐个 abort——
  // 那是从前 switchPreset 在本文件内时才有的能力，跨窗口切换现在无法触发。已知接受的缺口
  // （见记忆 settings-window-cross-window-abort-gap）：只影响本窗口渲染状态的短暂串味
  // （旧 session 的 SSE 回复在切换之后才到达、被追加到已经切到新 session 的界面上），
  // 后端 /chat 按 dispatch 时刻捕获的 sessionId 落库，消息归属不受影响，不是数据一致性问题
  const activeControllersRef = useRef<Set<AbortController>>(new Set())
  // preset 切换已搬到设置窗口发起，这里改为承接"窗口重新聚焦时发现 session 已变"的同步请求——
  // 快速连续聚焦（或聚焦期间又发生一次切换）时，上一次同步还在途中的请求必须被中断，否则哪个
  // 请求先返回不确定，可能出现"其它信息已经是新 session，但头像还是旧的"这种局部状态不一致
  const sessionSyncControllerRef = useRef<AbortController | null>(null)
  // 让窗口聚焦时的 session 同步检查能读到"当前显示的 appState"的最新值，而不是聚焦监听器
  // 挂载时（[] 依赖、只创建一次）闭包捕获的旧值
  const appStateRef = useRef<AppState | null>(null)
  // 是否已经完成过一次"应用生命周期内的首次冷启动预热"——后续如果因为空闲卸载机制导致
  // embeddingReady 又变回 false，不应该重新触发下面这套高频轮询（那是为首次冷启动设计的），
  // 交给窗口聚焦 / 发消息两个已有的检查时机去捕捉"是否又恢复了"就够了
  const hasCompletedInitialWarmupRef = useRef(false)

  useEffect(() => {
    appStateRef.current = appState
  }, [appState])

  useEffect(() => {
    if (hasFetched.current) return
    hasFetched.current = true

    fetch(`${CORE_URL}/state`)
      .then(r => r.json())
      .then((state: AppState) => {
        // 视为"第 0 次同步"接入 sessionSyncControllerRef：如果这次初始请求还没返回、
        // 窗口就已经聚焦触发过一次 session 同步，聚焦处理函数开头会把这个 controller 一并
        // abort 掉，避免晚到的初始结果把已经同步好的新状态（appState/wallpaper/头像）悄悄
        // 覆盖回去。如果聚焦同步在这次初始请求返回之前就已经开始（甚至已经跑完），
        // sessionSyncControllerRef.current 会已经非 null（聚焦同步自己的 abort 此时扑空，
        // 因为它开始时这个 ref 还是 null）——这种情况下这次初始 /state 结果已经过期，直接放弃
        if (sessionSyncControllerRef.current) return
        const controller = new AbortController()
        sessionSyncControllerRef.current = controller

        setAppState(state)
        setEmbeddingReady(state.embeddingReady)
        setWallpaperUrl(wallpaperUrlFor(state.presetSnapshot))
        if (state.presetSnapshot?.characterId) {
          fetchAvatarUrl(state.presetSnapshot.characterId, controller.signal).then(url => {
            if (controller.signal.aborted) return
            setAvatarUrl(url)
          })
        }
        if (state.sessionId) {
          loadInitialMessages(state.sessionId, controller.signal)
        }
      })
      .catch(() => {
        addSystemMessage('无法连接核心服务，请确认服务已启动', true)
      })
  }, [])

  // 预热期间轮询：仅覆盖应用生命周期内第一次冷启动预热——embeddingReady 为 false 且尚未完成过
  // 首次预热时，每 3 秒查一次轻量端点，一旦变为 true 就停止轮询并标记首次预热已完成。之后如果
  // embeddingReady 因整理模式的空闲卸载机制又变回 false，不再重新触发这套高频轮询，交给窗口
  // 聚焦 / 发消息两处已有的检查时机去捕捉"是否又恢复了"
  useEffect(() => {
    if (embeddingReady) {
      hasCompletedInitialWarmupRef.current = true
      return
    }
    if (hasCompletedInitialWarmupRef.current) return

    const interval = setInterval(() => {
      fetchEmbeddingReady().then(ready => {
        if (ready !== undefined) setEmbeddingReady(ready)
      })
    }, 3000)

    return () => clearInterval(interval)
  }, [embeddingReady])

  // 窗口重新聚焦时刷新：独立于轮询，即使当前 embeddingReady 已经是 true 也要检查——
  // 用于捕捉"窗口失焦期间因空闲被整理模式释放"这种情况；同时借这个时机检查 session 是否
  // 已在设置窗口被切换（preset 切换的发起方已经搬到设置窗口，聊天窗口自己不再知道），
  // 已知局限：如果切换后一直不切回聊天窗口，这里不会主动刷新，要等真正聚焦才补上——
  // 接受的缺口，等 GET /events 落地再替换
  useEffect(() => {
    const syncSessionOnFocus = async () => {
      try {
        const response = await fetch(`${CORE_URL}/state`)
        const state: AppState = await response.json()
        if (state.sessionId === appStateRef.current?.sessionId) return

        sessionSyncControllerRef.current?.abort()
        const controller = new AbortController()
        sessionSyncControllerRef.current = controller

        setAppState(state)
        setWallpaperUrl(wallpaperUrlFor(state.presetSnapshot))
        // 立即清空，避免新角色的名字/壁纸/消息列表已经更新、但头像还残留旧角色那张图
        // 的短暂不一致状态——和之前 switchPreset 成功分支的处理保持一致
        setAvatarUrl(undefined)
        setMessages([])
        setHasMoreHistory(false)
        oldestMessageIdRef.current = null
        isLoadingMoreRef.current = false
        if (state.sessionId) {
          loadInitialMessages(state.sessionId, controller.signal)
        }

        const nextAvatarUrl = state.presetSnapshot?.characterId
          ? await fetchAvatarUrl(state.presetSnapshot.characterId, controller.signal)
          : undefined
        if (controller.signal.aborted) return
        setAvatarUrl(nextAvatarUrl)
      } catch {
        // 聚焦时的被动同步检查失败不展示错误提示——不是用户主动触发的操作，
        // 静默忽略即可，下次聚焦或轮询会再试
      }
    }

    const handler = () => {
      fetchEmbeddingReady().then(ready => {
        if (ready !== undefined) setEmbeddingReady(ready)
      })
      syncSessionOnFocus()
    }
    window.addEventListener('focus', handler)
    return () => window.removeEventListener('focus', handler)
  }, [])

  // 加载最近一页历史消息（挂载时的初始 /state 请求成功后、以及每次聚焦触发的 session 同步
  // 成功后各调用一次），接入调用方传入的 controller signal，与 fetchAvatarUrl 同款竞态保护
  async function loadInitialMessages(sessionId: string, signal: AbortSignal) {
    try {
      const response = await fetch(
        `${CORE_URL}/messages?sessionId=${encodeURIComponent(sessionId)}&limit=${INITIAL_HISTORY_LIMIT}`,
        { signal }
      )
      if (!response.ok) throw new Error(`HTTP ${response.status}`)

      const page: MessagesPageResponse = await response.json()
      if (signal.aborted) return

      // 不能无条件整体覆盖：这次请求在途期间，用户可能已经发送了一条新消息（sendMessage
      // 用的是函数式 append），整体覆盖会把这条刚发送、尚未写入这次历史页快照的消息从
      // 界面上冲掉（消息本身已经发到后端，只是本地气泡消失）。空列表时才是纯粹的初始填充，
      // 非空说明加载期间已经有新内容追加，把历史拼在它前面而不是替换掉它
      setMessages(prev => prev.length === 0 ? page.messages.map(toMessageData) : [...page.messages.map(toMessageData), ...prev])
      setHasMoreHistory(page.hasMore)
      oldestMessageIdRef.current = page.messages[0]?.id ?? null
      // 触发 MessageList 一次性滚动到底部
      setInitialLoadSignal(n => n + 1)
    } catch (err) {
      if (err instanceof DOMException && err.name === 'AbortError') return
      addSystemMessage('加载历史消息失败', true)
    }
  }

  // 上滑到顶部时加载更早一页历史消息，prepend 到当前消息列表前面
  async function loadMoreMessages() {
    const sessionId = appState?.sessionId
    const beforeId = oldestMessageIdRef.current
    if (!sessionId || !hasMoreHistory || isLoadingMoreRef.current || beforeId === null) return

    isLoadingMoreRef.current = true
    // 接入当前这次 session 同步的 controller：session 切换时应中断掉仍在途的"加载更多"请求，
    // 否则它可能在新 session 的历史加载完之后才返回，把旧 session 的消息错误地 prepend 进去
    const signal = sessionSyncControllerRef.current?.signal
    try {
      const response = await fetch(
        `${CORE_URL}/messages?sessionId=${encodeURIComponent(sessionId)}&limit=${LOAD_MORE_HISTORY_LIMIT}&beforeId=${beforeId}`,
        signal ? { signal } : undefined
      )
      if (!response.ok) throw new Error(`HTTP ${response.status}`)

      const page: MessagesPageResponse = await response.json()
      if (signal?.aborted) return

      setMessages(prev => [...page.messages.map(toMessageData), ...prev])
      setHasMoreHistory(page.hasMore)
      if (page.messages.length > 0) {
        oldestMessageIdRef.current = page.messages[0].id
      }
    } catch (err) {
      // AbortError 是 session 同步主动中断导致的，不算失败，不展示错误气泡；
      // 其它失败（网络错误、后端 4xx/5xx）与 loadInitialMessages 保持一致，
      // 展示错误气泡而不是静默吞掉——否则用户会在毫无提示的情况下反复上滑却永远加载不出更多
      if (!(err instanceof DOMException && err.name === 'AbortError')) {
        addSystemMessage('加载历史消息失败', true)
      }
    } finally {
      isLoadingMoreRef.current = false
    }
  }

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
    // 发消息时机刷新：仅当当前没有在途的 /chat 请求时才顺带查一次（有在途请求说明近期已经
    // 活跃，没必要额外发起）；fire-and-forget，不 await，不能延迟或阻挡下面的实际发送
    if (activeControllersRef.current.size === 0) {
      fetchEmbeddingReady().then(ready => {
        if (ready !== undefined) setEmbeddingReady(ready)
      })
    }

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
      className={`chat-window${embeddingReady ? '' : ' chat-window--embedding-not-ready'}`}
      style={wallpaperUrl ? { backgroundImage: `url(${wallpaperUrl})` } : undefined}
    >
      {appState?.ollamaReady === false && (
        <div className="banner banner--warn">
          Ollama 未运行，请先启动 Ollama
        </div>
      )}

      <div className="chat-area">
        <MessageList
          // session 切换时强制重挂载，重置内部的 pendingScrollAdjustRef/prevFirstIdRef——
          // 否则上一个 session 遗留的滚动补偿标记可能在新 session 的消息列表上误触发一次
          // 无意义的 scrollTop 调整
          key={appState?.sessionId ?? 'no-session'}
          messages={messages}
          isReplying={isReplying}
          avatarUrl={avatarUrl}
          displayName={displayName}
          hasMoreHistory={hasMoreHistory}
          onLoadMore={loadMoreMessages}
          scrollToBottomSignal={initialLoadSignal}
        />
      </div>

      <div className="input-area">
        <InputBar onSend={sendMessage} />
      </div>
    </div>
  )
}
