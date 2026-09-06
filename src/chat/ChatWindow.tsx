import React, { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { MessageList } from './MessageList'
import { InputBar } from './InputBar'
import { TitleBar } from './TitleBar'
import { MessageData } from './MessageBubble'
import { parseSSE } from './sse'
import { deriveTheme } from './theme.js'
import { DEFAULT_CHAT_BG_OPACITY, DEFAULT_THEME_INPUT, resolveThemeMode, themeCssVars, titlebarOverlayFromTheme } from './themeVars.js'
import { usePrefersDark } from '../usePrefersDark.js'
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

// 用户头像manifest.userAvatar
// 未配置时返回 undefined，MessageBubble 据此完全不渲染用户侧的头像位置
async function fetchUserAvatarUrl(characterId: string, signal?: AbortSignal): Promise<string | undefined> {
  try {
    const res = await fetch(`${CORE_URL}/characters/${encodeURIComponent(characterId)}/manifest.json`, { signal })
    if (!res.ok) return undefined

    const manifest: { userAvatar?: string } = await res.json()
    if (!manifest.userAvatar) return undefined

    return `${CORE_URL}/characters/${encodeURIComponent(characterId)}/${encodeURIComponent(manifest.userAvatar)}`
  } catch {
    return undefined
  }
}

// 'auto' 解析成具体 'day'/'night' 是渲染层的职责（theme.ts 明确不处理，见 themeVars.ts
// resolveThemeMode 的注释）。usePrefersDark 本身抽到 src/usePrefersDark.ts——设置窗口的
// 主题实时预览（settings/CharacterPanel.tsx）也需要同一份'auto'解析逻辑，不属于本窗口
// 独有

export function ChatWindow() {
  const hasFetched = useRef(false)
  const [messages, setMessages] = useState<MessageData[]>([])
  const [isReplying, setIsReplying] = useState(false)
  const [appState, setAppState] = useState<AppState | null>(null)
  const prefersDark = usePrefersDark()
  // 保守默认值：挂载时的初始 /state 请求返回前，先当作"未就绪"处理（头像置灰），
  // 避免在真正尚未预热完成时短暂显示"已就绪"的误导状态
  const [embeddingReady, setEmbeddingReady] = useState<boolean>(false)
  const [wallpaperUrl, setWallpaperUrl] = useState<string | null>(null)
  const [avatarUrl, setAvatarUrl] = useState<string | undefined>(undefined)
  const [userAvatarUrl, setUserAvatarUrl] = useState<string | undefined>(undefined)
  // 是否还有更多历史消息可加载，决定 MessageList 要不要在滑到顶部时触发 onLoadMore
  const [hasMoreHistory, setHasMoreHistory] = useState(false)
  // 每次初始历史加载完成后递增，触发 MessageList 一次性滚动到底部
  const [initialLoadSignal, setInitialLoadSignal] = useState(0)
  // 下一次"加载更多"的游标（当前已加载消息里最早一条的 id），不需要触发重渲染，用 ref 即可
  const oldestMessageIdRef = useRef<number | null>(null)
  // 防止同一时刻并发触发多次"加载更多"请求
  const isLoadingMoreRef = useRef(false)
  // 回复进行中用户仍可继续发送新消息，同一时间可能有多个 /chat 请求在途，用 Set 记录它们。
  // preset 切换搬到设置窗口后，本窗口通过 GET /events 的 preset-switched 广播感知到切换，
  // 在 syncSessionOnFocus 检测到 sessionId 确实变化的分支里遍历这个 Set 逐个 abort（见下方
  // 聚焦同步 effect），避免旧 session 的 SSE 回复在切换之后才到达、被追加到已经切到新 session
  // 的界面上
  const activeControllersRef = useRef<Set<AbortController>>(new Set())
  // preset 切换已搬到设置窗口发起，这里改为承接"窗口重新聚焦时发现 session 已变"的同步请求——
  // 只在 sessionId 确实变化、需要做重置动作（清空消息、重拉历史、重取头像）时才用到；
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
          fetchUserAvatarUrl(state.presetSnapshot.characterId, controller.signal).then(url => {
            if (controller.signal.aborted) return
            setUserAvatarUrl(url)
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
  // 已在设置窗口被切换（preset 切换的发起方已经搬到设置窗口，聊天窗口自己不再知道）。
  // 按两级处理：每次聚焦都把最新的 presetSnapshot 应用到界面（名字、壁纸、背景叠色变量），
  // 只有 sessionId 确实变化时才做重置动作（清空消息列表、重新加载历史、重取头像、重置分页
  // 游标、abort 掉仍在途的旧 session /chat 请求）——轻量字段无条件刷新、重操作按 sessionId
  // 把关，否则从设置窗口改完当前角色的显示设置，聊天窗口要等重开窗口才生效。
  // 同时订阅 GET /events 的 preset-switched 广播（TDD §3.3），收到后立即调用同一个
  // syncSessionOnFocus，不需要等窗口真正聚焦才补上这次同步——这就是"等 GET /events 落地
  // 再替换"那个缺口的替换：现在切换后即使一直不切回聊天窗口，本窗口也能第一时间感知
  useEffect(() => {
    const syncSessionOnFocus = async () => {
      try {
        const response = await fetch(`${CORE_URL}/state`)
        const state: AppState = await response.json()

        // 轻量字段：无论 sessionId 是否变化都要应用，让设置窗口改的名字/壁纸/背景叠色
        // 立即在聊天窗口生效，不必等一次真正的 session 切换
        setAppState(state)
        setWallpaperUrl(wallpaperUrlFor(state.presetSnapshot))

        if (state.sessionId === appStateRef.current?.sessionId) return

        // session 确实变化：abort 掉所有仍在途的旧 session /chat 请求，避免它们的
        // message_done/system 事件在切换之后才到达、被追加到已经切到新 session 的界面上
        // （见 activeControllersRef 声明处的说明）
        activeControllersRef.current.forEach(controller => controller.abort())
        activeControllersRef.current.clear()

        sessionSyncControllerRef.current?.abort()
        const controller = new AbortController()
        sessionSyncControllerRef.current = controller

        // 立即清空，避免新角色的名字/壁纸/消息列表已经更新、但头像还残留旧角色那张图
        // 的短暂不一致状态——和之前 switchPreset 成功分支的处理保持一致
        setAvatarUrl(undefined)
        setUserAvatarUrl(undefined)
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
        const nextUserAvatarUrl = state.presetSnapshot?.characterId
          ? await fetchUserAvatarUrl(state.presetSnapshot.characterId, controller.signal)
          : undefined
        if (controller.signal.aborted) return
        setAvatarUrl(nextAvatarUrl)
        setUserAvatarUrl(nextUserAvatarUrl)
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

    // GET /events 共享广播流（与 src/overlay/OverlayApp.tsx 消费 emotion 事件同款写法：
    // 原生 EventSource，按 event 名注册监听器）。preset-switched 走的是与聚焦处理函数完全
    // 相同的代码路径，不重复实现一遍判断/重置逻辑
    const eventSource = new EventSource(`${CORE_URL}/events`)
    const onPresetSwitched = () => {
      syncSessionOnFocus()
    }
    eventSource.addEventListener('preset-switched', onPresetSwitched)

    return () => {
      window.removeEventListener('focus', handler)
      eventSource.removeEventListener('preset-switched', onPresetSwitched)
      eventSource.close()
    }
  }, [])

  const displayConfig = appState?.presetSnapshot?.displayConfig

  // theme.ts 的主入口：displayConfig 缺失时（v7 之前创建的历史冻结快照）不能直接跳过——
  // CSS 那半会自然降级到 global.css `:root` 里的默认主题色，而下面的原生按钮条带 IPC
  // 没有等价降级，会停在上一个 preset 推下来的值，出现「两层各说各话」（同一个坑此前用
  // DEFAULT_CHAT_BG_RGB 修过一次，见 chromeColor.ts 的历史注释）。这里同样落到一份固定
  // 兜底输入（DEFAULT_THEME_INPUT），让两层永远收敛到同一个 theme
  const resolvedMode = displayConfig ? resolveThemeMode(displayConfig.themeMode, prefersDark) : DEFAULT_THEME_INPUT.mode
  const theme = useMemo(() => {
    if (!displayConfig) return deriveTheme(DEFAULT_THEME_INPUT)
    return deriveTheme({
      accentRgb: displayConfig.accentRgb,
      mode: resolvedMode,
      tintStrength: displayConfig.tintStrength,
    })
  }, [displayConfig, resolvedMode])
  const chatBgOpacity = displayConfig?.chatBgOpacity ?? DEFAULT_CHAT_BG_OPACITY

  // 原生窗口按钮条带（Window Controls Overlay）不受 CSS 管辖，主题变化时把算好的
  // { color, symbolColor } 经单向 IPC 'titlebar:set-overlay' 下发给主进程，由它调用
  // win.setTitleBarOverlay() 应用（TDD §3.2.2「渲染层消费」路径 3、§3.7 附「聊天窗口
  // chrome 模型」）
  useEffect(() => {
    window.electronAPI.setTitlebarOverlay(titlebarOverlayFromTheme(theme))
  }, [theme])

  // 主题 CSS 变量挂在 document.documentElement 上，而不是聊天窗口根 div 的内联 style——
  // global.css 的 `html, body, #root { color: ... }` 是这个根 div 的**祖先**，内联样式
  // 只会级联到该 div 自己的子树，永远到不了它的祖先，此前这条规则因此永远读的是
  // global.css `:root` 里的静态占位值（day 模式下的实际主题色因此从未真正生效在
  // html/body/#root 上——这是一个存在已久的 day 模式 bug）。挂到 documentElement 上，
  // html/body/#root 与聊天窗口 div 就都是它的后代，同一份变量天然级联到两边，不需要
  // 再各写一份。用 useLayoutEffect 而不是 useEffect：在浏览器画下一帧之前同步写入，
  // 避免每次主题变化都闪一下 global.css 的占位色再跳到真正的主题色。
  // color-scheme 顺带在这里跟着 resolvedMode 一起设置：原生控件（select 弹出层、
  // checkbox、range 滑块、日期选择器）此前完全没有这个属性，一律按浏览器默认的浅色渲染，
  // night 模式下会看到一圈突兀的白色原生控件
  useLayoutEffect(() => {
    const root = document.documentElement
    const vars = themeCssVars(theme, chatBgOpacity)
    for (const [name, value] of Object.entries(vars)) {
      root.style.setProperty(name, value)
    }
    root.style.colorScheme = resolvedMode === 'day' ? 'light' : 'dark'
  }, [theme, chatBgOpacity, resolvedMode])

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
          const { text: replyText, sessionId: replySessionId } = data as { messageId: string; text: string; sessionId: string }
          // controller.signal.aborted 拦不住"切换检测本身还没跑完、旧 session 模型调用
          // 却先一步完成"这种情况（见后端 chat.ts send('message_done', ...) 处的注释）——
          // 这里改按后端回带的 sessionId 是否还等于当前实际展示的会话来判断，appStateRef
          // 读到的是 syncSessionOnFocus 完成同步后的最新值，不是这次请求发起时的旧闭包值
          if (replySessionId !== appStateRef.current?.sessionId) continue
          setMessages(prev => [...prev, {
            id: Date.now().toString(),
            role: 'assistant' as const,
            content: replyText,
            createdAt: Date.now(),
          }])
        }

        if (event === 'system') {
          const { payload, sessionId: replySessionId } = data as { type: string; payload: { message: string }; sessionId: string }
          if (replySessionId !== appStateRef.current?.sessionId) continue
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
      <TitleBar avatarUrl={avatarUrl} displayName={displayName} />

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
          userAvatarUrl={userAvatarUrl}
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
