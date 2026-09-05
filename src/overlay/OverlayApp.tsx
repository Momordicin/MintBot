import React, { useEffect, useRef, useState } from 'react'
import type { AppState } from '../../shared/types/index.js'
import './overlay.css'
import {
  type OverlayManifest,
  type YState,
  deriveY,
  nextThresholdInstant,
} from './portraitState.js'
import {
  type ResolvedTransitionStep,
  type TransitionTrigger,
  isTransitionLocked,
  resolveOverlayDisplayFile,
  resolveTransitionChain,
  selectTransitionTrigger,
  transitionEndInstant,
} from './transitionState.js'

const CORE_URL = 'http://127.0.0.1:3000'

// 位移阈值本身 TDD 没有钉死具体像素数（⚠️「附带的误触发」只要求"加一道判定"），5px
// 是常见的"点击 vs 拖拽"经验阈值（明显小于误触发所需的可感知移动，又不会误伤真正的点击）
const CLICK_DISPLACEMENT_THRESHOLD_PX = 5

// GET /events 的 emotion 事件负载：广播端（services/core/routes/chat.ts）在没有
// 有效情绪解析结果时会广播 self: null，与 shared/types 里 EmotionState.self 声明为
// 非空的 EmotionLabel 不完全一致——本地按实际观察到的运行时形状定义，不强改共享类型
interface EmotionEventPayload {
  self: { label: string; intensity: number } | null
  perceived_user: unknown
}

// manifest 里的路径相对角色包根目录，可能带子目录（如 "gifs/idle1.gif"）——逐段
// encodeURIComponent 再用 '/' 拼回，不能对整串一起编码（会把路径分隔符也编码掉）
function resolveAssetUrl(characterId: string, relativePath: string): string {
  const encodedPath = relativePath.split('/').map(encodeURIComponent).join('/')
  return `${CORE_URL}/characters/${encodeURIComponent(characterId)}/${encodedPath}`
}

export function OverlayApp() {
  const [characterId, setCharacterId] = useState<string | null>(null)
  const [file, setFile] = useState<string | null>(null)
  // manifest 随 preset-switched 广播刷新（见下方 loadCharacterAndPortrait），用 ref 存它是为了
  // 让 EventSource 的 emotion 事件回调（只在挂载时注册一次，见下一个 effect）每次都能读到
  // 最新值，而不是闭包捕获注册那一刻的旧值
  const manifestRef = useRef<OverlayManifest | undefined>(undefined)
  // y/x 两台平级状态机的当前值（TDD §3.7 附「两台平级状态机 [x, y]」）：x 由 emotion 事件
  // 更新，y 由载入/定时器触发的阈值求值更新。两者都要用 ref 存——y 展示期间 x 仍需照常
  // 更新以便 y 消失后落到"最新的" x（不是进入 y 之前那个），而不是靠重渲染保存
  const yRef = useRef<YState>(null)
  const xRef = useRef<string | undefined>(undefined)
  // 距下一阈值绝对时刻的一次性定时器（TDD「应按下一个阈值的绝对时刻调度一次性定时器，而不是
  // 轮询」）。preset-switched 广播与卸载时都需要清掉，避免旧 preset 的定时器在新 preset 之上触发
  const timerRef = useRef<ReturnType<typeof setTimeout> | undefined>(undefined)
  // 用递增的"代次"而不是一次性的布尔值来识别过期回调：loadCharacterAndPortrait 可能被
  // 多次调用（挂载一次 + 每次 preset-switched 广播各一次 + 每次阈值定时器触发各一次），任何
  // 一次调用的异步回调都必须只在"仍然是发起时那一代"时才生效——否则布尔值一旦被卸载清理函数
  // 置为已失效，React.StrictMode（src/overlay/main.tsx）开发环境下的"挂载→卸载→再挂载"探测性
  // 双调用会让它永远卡在失效状态，之后真正的那次挂载和所有后续触发的重新加载都会直接被当成
  // 过期请求丢弃；同理，两次触发挨得很近时，后一次发起的调用也需要能让前一次仍在途的回调作废，
  // 不能靠一个共享的布尔值区分"谁是最新的那次"
  const loadGenRef = useRef(0)
  // 转场播放期间的当前步文件（null 表示当前没有转场在播放，见 transitionState.ts
  // resolveOverlayDisplayFile 的展示优先级）。转场结束（播完或被隐藏切断）时清回 null
  const transitionFileRef = useRef<string | null>(null)
  // 交互锁的绝对结束时刻（TDD「交互锁」：持续到转场的绝对结束时刻，而非倒计时）。
  // null 表示当前未锁。isTransitionLocked 只依赖这个时刻与当前时钟判断，不依赖下面
  // transitionTimerRef 的回调是否已经触发——素材加载失败/404 不该影响锁的释放
  const transitionEndAtRef = useRef<number | null>(null)
  // 转场播放的分步定时器：每步播完后推进到下一步，最后一步播完后结束转场。preset-switched
  // 广播、隐藏窗口（visibilitychange）与卸载时都需要清掉，避免旧转场在新状态之上继续推进
  const transitionTimerRef = useRef<ReturnType<typeof setTimeout> | undefined>(undefined)
  // 点击判定的位移阈值起点坐标（TDD ⚠️「附带的误触发」）：mousedown 时记录，click 触发时
  // 与松开位置比较；null 表示这次 click 之前没有配对的 mousedown（理论上不会发生，因为
  // click 要求 down/up 落在同一元素上，留 null 只是让比较逻辑天然跳过而不是断言失败）
  const mouseDownPosRef = useRef<{ x: number; y: number } | null>(null)

  // 按下一个阈值的绝对时刻调度一次性定时器（TDD「阈值表」运行期部分）。定时器到点后必须
  // 先重新拉取 GET /state 再重算 y，而不是本地推算：一是显式睡着标记没有推送通道（另一个
  // agent 正在改的 chat.ts 让 sleep 回复不再广播 emotion 事件），只有到点重新拉取才能第一次
  // 让它生效；二是它天然纠正"悬浮窗错过的用户消息"——刷新时刻靠这次拉取带回的更新后
  // lastAttentionAt 重算，y 该维持空就维持空，绝不会先展示错误的一帧。因此复用
  // loadCharacterAndPortrait 本身（它在拿到新数据后会再调用本函数重新调度），不另写一套
  function scheduleThresholdCheck(lastAttentionAt: number | null) {
    if (timerRef.current !== undefined) {
      clearTimeout(timerRef.current)
      timerRef.current = undefined
    }
    const next = nextThresholdInstant(lastAttentionAt, Date.now())
    if (next === null) return
    timerRef.current = setTimeout(loadCharacterAndPortrait, Math.max(0, next - Date.now()))
  }

  // 读取 characterId + 立绘状态（y/x）+ manifest 并应用展示——挂载时跑一次，收到
  // preset-switched 广播时跑一次，阈值定时器触发时也跑一次，三处复用同一套逻辑，不各写一遍
  // （TDD「悬浮窗重载时主动调用状态快照接口拉取当前情绪标签和立绘状态，不依赖本地缓存」）
  function loadCharacterAndPortrait() {
    const gen = ++loadGenRef.current

    fetch(`${CORE_URL}/state`)
      .then(r => r.json())
      .then((state: AppState) => {
        if (gen !== loadGenRef.current) return
        const id = state.presetSnapshot?.characterId
        if (!id) return
        setCharacterId(id)

        // y 的求值只实现「显式睡着标记」与「阈值表」两层（本批次范围，TDD「y 的求值顺序」）；
        // x 取自当前情绪状态，与 y 是平级、互不覆写的两台状态机
        yRef.current = deriveY({
          lastAttentionAt: state.lastAttentionAt,
          explicitSleep: state.explicitSleep,
          now: Date.now(),
        })
        xRef.current = state.emotion?.self?.label
        scheduleThresholdCheck(state.lastAttentionAt)

        return fetch(`${CORE_URL}/characters/${encodeURIComponent(id)}/manifest.json`)
          .then(r => r.json())
          .then((manifest: OverlayManifest) => {
            if (gen !== loadGenRef.current) return
            manifestRef.current = manifest
            setFile(resolveOverlayDisplayFile(manifestRef.current, transitionFileRef.current, yRef.current, xRef.current))
          })
      })
      .catch(() => {
        // 核心服务未就绪/不可达：悬浮窗保持透明空白，不重试、不报错
      })
  }

  // 播放转场链条中的第 index 步：展示该步文件，用一次性定时器在 durationMs 后推进到
  // 下一步；index 越界（最后一步播完）即结束转场。是否继续推进只看数组长度，不看素材是否
  // 真的加载成功——锁的释放只依赖时钟这条约束（见 transitionState.ts isTransitionLocked
  // 的注释）同样适用于播放本身，否则一张 404 的图会让整条转场卡在那一步不动
  function playTransitionStep(steps: ResolvedTransitionStep[], index: number) {
    if (index >= steps.length) {
      endTransition()
      return
    }
    const step = steps[index]
    transitionFileRef.current = step.file
    setFile(step.file)
    transitionTimerRef.current = setTimeout(() => playTransitionStep(steps, index + 1), step.durationMs)
  }

  // 转场结束——无论是正常播完最后一步，还是被隐藏窗口（visibilitychange）提前切断：
  // 清空转场态与锁，然后复用 loadCharacterAndPortrait 重新拉取 /state（本批次任务书
  // "refetch /state by reusing loadCharacterAndPortrait"）。这样才能拿到唤醒动作已经
  // 刷新过的 lastAttentionAt/explicitSleep，重新起链阈值定时器——portraitState.ts
  // nextThresholdInstant 的既有注释也点名调用方必须另有重新起链的入口，这里正是其一
  function endTransition() {
    if (transitionTimerRef.current !== undefined) {
      clearTimeout(transitionTimerRef.current)
      transitionTimerRef.current = undefined
    }
    transitionFileRef.current = null
    transitionEndAtRef.current = null
    loadCharacterAndPortrait()
  }

  // 唤醒并播放对应转场（TDD「点击小人按 y 分支」+「唤醒与转场」）。trigger 由调用方按
  // 唤醒前的 y 选定。链条一步都解析不出素材时 resolveTransitionChain 返回空数组——按
  // TDD「回落规则」"不播转场，直接完成状态切换"的等价情况处理：不上锁、不播放，直接
  // 复用 loadCharacterAndPortrait 让状态切换（唤醒本身已经在调用方里通过 POST
  // /internal/overlay-interaction 生效）立即反映出来，绝不能让转场把立绘卡住
  function startTransition(trigger: TransitionTrigger) {
    const steps = resolveTransitionChain(manifestRef.current, trigger)
    if (steps.length === 0) {
      // 不播转场时直接按本地已知状态完成切换，而不是回拉 /state：调用方在唤醒时已经
      // 把 y 按"刚被搭理"更新过，而那次 POST 与这里的 GET 之间没有任何顺序保证——先到的
      // /state 可能还没反映出唤醒，立绘会表现成"点了没醒"。有转场的路径不受影响：3~6 秒的
      // 播放时间足够让上报落地，所以 endTransition 那次回拉仍然照常保留
      setFile(resolveOverlayDisplayFile(manifestRef.current, null, yRef.current, xRef.current))
      return
    }
    transitionEndAtRef.current = transitionEndInstant(steps, Date.now())
    playTransitionStep(steps, 0)
  }

  // 点击判定：mousedown 记录起点，click 触发时先按位移阈值过滤误触发（TDD ⚠️「附带的误
  // 触发」），再检查交互锁（锁期间一律丢弃，不排队），最后按 y 分支决定动作（TDD「点击
  // 小人按 y 分支」）：无聊/睡着 → 上报交互 + 播放对应转场、不开聊天窗口；空 → 沿用既有的
  // 打开聊天窗口行为
  function handleMouseDown(event: React.MouseEvent) {
    mouseDownPosRef.current = { x: event.clientX, y: event.clientY }
  }

  function handlePortraitClick(event: React.MouseEvent) {
    const start = mouseDownPosRef.current
    mouseDownPosRef.current = null
    if (start) {
      const displaced = Math.hypot(event.clientX - start.x, event.clientY - start.y) > CLICK_DISPLACEMENT_THRESHOLD_PX
      if (displaced) return // 位移超阈值：判定为误触发，不算点击
    }

    if (isTransitionLocked(transitionEndAtRef.current, Date.now())) return // 锁期间丢弃交互

    if (yRef.current === 'boredom-idle' || yRef.current === 'sleep') {
      const trigger = selectTransitionTrigger(yRef.current)
      // 上报失败也照常播放转场——播放只依赖本地时钟与已加载的 manifest，不依赖这次上报
      // 成功与否；真实是否"唤醒"以服务端记录为准，转场结束后 endTransition 重新拉取
      // /state 会按服务端实际状态纠正（与本文件其它 fetch 失败时的静默处理一致）
      fetch(`${CORE_URL}/internal/overlay-interaction`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ type: 'portrait-click' }),
      }).catch(() => {})

      // 与 emotion 帧同款的本地乐观更新：点击唤醒本身就是"搭理 bot"的三种交互之一，
      // 所以此刻 lastAttentionAt ≈ 现在、explicitSleep 已被 recordAttention 清掉，不必等
      // 服务端回合就能确定 y。这样做同时消掉两处竞态：零步链条那条路不会再被一个尚未反映
      // 唤醒的 /state 覆盖回睡着；而转场播完时 endTransition 先释放锁、再异步刷新 y 的那个
      // 窗口里，y 也已经是空的，落在窗口里的下一次点击不会重复触发一次唤醒。
      // 上报真的失败时不会一直错下去：endTransition 的 /state 回拉、以及重新起链后的阈值
      // 定时器，都会按服务端实际状态把它纠正回睡着/无聊
      const now = Date.now()
      yRef.current = deriveY({ lastAttentionAt: now, explicitSleep: false, now })
      scheduleThresholdCheck(now)

      startTransition(trigger)
      return
    }

    window.electronAPI.activateFromOverlay()
  }

  useEffect(() => {
    loadCharacterAndPortrait()
    // 卸载时把代次再往前推一格，让挂载期间任何仍在途的回调都识别为过期——不需要额外的
    // 布尔标记，判断逻辑与"被更新的一次调用取代"完全一样，天然覆盖卸载这一种情况。同时
    // 清掉阈值定时器与转场分步定时器，避免组件已卸载后它们还各自触发一次副作用
    return () => {
      loadGenRef.current++
      if (timerRef.current !== undefined) {
        clearTimeout(timerRef.current)
      }
      if (transitionTimerRef.current !== undefined) {
        clearTimeout(transitionTimerRef.current)
      }
    }
  }, [])

  // 悬浮窗隐藏即终结转场、释放交互锁（TDD「交互锁」必须由构造保证的性质第二条：隐藏不等于
  // 唤醒，只终结转场本身，不触碰持久条件状态）。用 document.visibilityState 而不是监听
  // Electron 窗口事件：BrowserWindow.hide()（主进程 overlay:activate / win.on('focus') 都会
  // 触发）会让渲染进程的 visibilityState 变成 hidden，这是纯 Web 标准事件，不需要额外的
  // IPC 通道。只有确实有转场在播放（transitionEndAtRef 非 null）时才需要处理，没有转场时
  // 隐藏不做任何事——没有锁可释放，也不该无谓地重新拉取 /state
  useEffect(() => {
    function handleVisibilityChange() {
      if (document.visibilityState === 'hidden' && transitionEndAtRef.current !== null) {
        endTransition()
      }
    }
    document.addEventListener('visibilitychange', handleVisibilityChange)
    return () => {
      document.removeEventListener('visibilitychange', handleVisibilityChange)
    }
  }, [])

  // 情绪变化实时更新 + preset 切换感知：纯 GET 无 body，用浏览器原生 EventSource，不需要
  // 手写 fetch+reader 解析（那是 /chat 私有流因为要发 POST 带 body 才需要的方案）。两个事件
  // 共用同一条连接（GET /events 是所有窗口共用的常驻连接，TDD §3.3）
  useEffect(() => {
    const source = new EventSource(`${CORE_URL}/events`)
    source.addEventListener('emotion', (event: MessageEvent) => {
      try {
        const data: EmotionEventPayload = JSON.parse(event.data)
        // 记录最新的 x，使 y → x 回落总是落到"最新的" x，而不是进入 y 之前那个（TDD「两者是
        // 平级的状态机……y 展示期间 x 照常更新，y 消失后落到的是最新的 x」）
        xRef.current = data.self?.label

        // 收到 emotion 帧这件事本身就足以确定后端此刻的两个值，无需再拉一次 GET /state：
        // 帧只由 services/core/routes/chat.ts 在处理一轮用户消息时发出，而那条路径必定先
        // 调过 recordAttention（刷新时刻 + 清除显式睡着标记）；且 sleep 回复两条通道都不发帧，
        // 所以"收到了帧"同时意味着本轮不是 sleep、markExplicitSleep 没有被调用。于是
        // lastAttentionAt ≈ 现在、explicitSleep === false 是已知事实而不是猜测，直接据此
        // 在本地重算 y 并重新调度阈值定时器即可（不拉 /state：buildStatePayload 会顺带做
        // Ollama / embedding 健康检查，每轮对话都拉一次太重，且 AI 服务不可达时还会拖慢）。
        // 这一步是正确性所必需，不是优化：定时器是 y 唯一的自愈通道，而它在「会话还没有任何
        // 历史消息」（无时长基准）和「已经走到 60 分钟睡着档」（没有下一层阈值）两种情况下
        // 都不会被调度，缺了这里就会出现"用户正在聊天、悬浮窗却一直停在无聊/睡着"的死锁
        const now = Date.now()
        yRef.current = deriveY({ lastAttentionAt: now, explicitSleep: false, now })
        scheduleThresholdCheck(now)

        // 每次收到事件都直接重新挑选一次文件，不依赖"情绪标签文本是否变化"——
        // 连续多轮情绪标签相同时也要有机会随机换一个变体展示，这正是 manifest 里
        // emotions 数组"多变体随机展示"设计的意义所在（TDD §3.7）。如果改成先
        // setState 情绪标签、再靠 useMemo 按标签是否变化决定要不要重挑，标签没变时
        // React 会因为状态相等而跳过重渲染，导致立绘永远卡在第一次选中的那个变体上。
        // 这里不再需要"y 非空就跳过"的判断：上一行刚把 y 按"刚被搭理"重算过，本批次的
        // y 只可能是由时刻派生的空/无聊/睡着三者之一，刷新时刻后必然为空（TDD「清空 y 是
        // 有条件的……在上面的求值模型下自动成立」）。这里不需要额外判断"转场是否在播放"——
        // resolveOverlayDisplayFile 本身就把转场文件放在最高优先级，若此刻恰好有转场在播放，
        // 这次重算不会打断它（点击唤醒不发消息，正常不会撞上这个分支，但仍按优先级兜底）
        setFile(resolveOverlayDisplayFile(manifestRef.current, transitionFileRef.current, yRef.current, xRef.current))
      } catch {
        // 忽略解析失败的事件，保留当前已展示的立绘
      }
    })
    source.addEventListener('preset-switched', () => {
      // 新角色的 manifest/立绘状态到达前先清空展示，避免新角色的情绪标签下短暂闪出
      // 旧角色的立绘（旧 file 对新角色的 emotions 词表大概率无意义，即使凑巧同名也是误导）。
      // 同时清掉旧 preset 的阈值定时器、转场分步定时器与交互锁，以及 y/x——旧 preset 的转场
      // 引用的是旧角色包的素材路径，继续播放会对着新 characterId 请求错误的文件，
      // 锁也没有理由继续拦截新 preset 上的交互
      if (timerRef.current !== undefined) {
        clearTimeout(timerRef.current)
        timerRef.current = undefined
      }
      if (transitionTimerRef.current !== undefined) {
        clearTimeout(transitionTimerRef.current)
        transitionTimerRef.current = undefined
      }
      transitionFileRef.current = null
      transitionEndAtRef.current = null
      manifestRef.current = undefined
      yRef.current = null
      xRef.current = undefined
      setFile(null)
      loadCharacterAndPortrait()
    })
    return () => {
      source.close()
    }
  }, [])

  const src = file && characterId ? resolveAssetUrl(characterId, file) : null

  return (
    <div className="overlay-root">
      {/* 点击恢复要挂在立绘本体上，不能挂在 overlay-root：root 整体是
          -webkit-app-region: drag，Windows 下拖动区域在 DOM 收到事件之前就被
          WM_NCHITTEST 拦成 HTCAPTION，普通 click 根本派发不到——立绘单独标记
          no-drag 才能正常收到点击，同时 root 上没被立绘盖住的部分仍然可拖动 */}
      {src && (
        <img
          className="overlay-portrait"
          src={src}
          alt=""
          onMouseDown={handleMouseDown}
          onClick={handlePortraitClick}
        />
      )}
    </div>
  )
}
