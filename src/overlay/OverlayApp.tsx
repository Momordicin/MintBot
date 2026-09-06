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
  shouldPlayFallAsleep,
  transitionEndInstant,
} from './transitionState.js'

const CORE_URL = 'http://127.0.0.1:3000'

// 位移阈值本身 TDD 没有钉死具体像素数（⚠️「附带的误触发」只要求"加一道判定"），5px
// 是常见的"点击 vs 拖拽"经验阈值（明显小于误触发所需的可感知移动，又不会误伤真正的点击）
const CLICK_DISPLACEMENT_THRESHOLD_PX = 5

// GET /events 的 emotion 事件负载：广播端（services/core/routes/chat.ts）在没有
// 有效情绪解析结果时会广播 self: null，与 shared/types 里 EmotionState.self 声明为
// 非空的 EmotionLabel 不完全一致——本地按实际观察到的运行时形状定义，不强改共享类型。
// sessionId/explicitSleep 是本轮新增字段（TDD §3.7 附「悬浮窗立绘状态模型」求值顺序
// 「有显式睡着标记」一层）：sessionId 是请求 dispatch 时刻捕获的值（与 message_done 同源），
// explicitSleep 是发帧那一刻核心服务侧显式睡着标记的权威值，不再需要靠"收到帧"这件事本身
// 去反推它
interface EmotionEventPayload {
  // self 是**可选键**：模型自发把 label 标成 sleep 那一轮，后端会整个省掉这个键（而不是
  // 发 self: null），因为「x 永不为 sleep」只需要不给 self 就够了，而发 null 会把 x 清空、
  // 违反 TDD §3.9「从睡着唤醒后回落到上一次真实的情绪」。因此消费方必须按「键在不在」
  // 判断要不要动 x，不能只看值——与 message_done 的 emote 字段同一约定
  self?: { label: string; intensity: number } | null
  perceived_user?: unknown
  sessionId: string
  explicitSleep: boolean
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
  // 交互锁是否锁着——只驱动 .overlay-root 的 -webkit-app-region（TDD「拖拽的实现方式」
  // "转场进行中禁止拖拽的做法是把 root 动态改为 no-drag，比在渲染层忽略事件更彻底"）。
  // 只在 startTransition 上锁、endTransition/preset-switched 清理释放锁这两处同步 setState，
  // 不靠"file 状态变了就顺带重算"这种间接触发：endTransition 释放锁后还要再异步回拉
  // /state 才会重新 setFile，若锁的 UI 反馈也等这次异步回来，用户会在网络往返这段时间里
  // 仍然拖不动窗口。直接调用 isTransitionLocked 而不是自己重复"是否为 null"的判断，
  // 保证这里与其它读锁的地方（点击判定）永远是同一个函数、同一个结论
  const [isLocked, setIsLocked] = useState(false)
  // manifest 随 preset-switched 广播刷新（见下方 loadCharacterAndPortrait），用 ref 存它是为了
  // 让 EventSource 的 emotion 事件回调（只在挂载时注册一次，见下一个 effect）每次都能读到
  // 最新值，而不是闭包捕获注册那一刻的旧值
  const manifestRef = useRef<OverlayManifest | undefined>(undefined)
  // y/x 两台平级状态机的当前值（TDD §3.7 附「两台平级状态机 [x, y]」）：x 由 emotion 事件
  // 更新，y 由载入/定时器触发的阈值求值更新。两者都要用 ref 存——y 展示期间 x 仍需照常
  // 更新以便 y 消失后落到"最新的" x（不是进入 y 之前那个），而不是靠重渲染保存
  const yRef = useRef<YState>(null)
  const xRef = useRef<string | undefined>(undefined)
  // 悬浮窗自己当前展示的会话（GET /state 的 sessionId，随 loadCharacterAndPortrait 每次
  // 拉取刷新）。emotion 帧的 sessionId 据此判断这帧是否还属于当前展示的角色——一次由
  // preset 切换前发起、切换后才跑完的模型调用，其 emotion 帧带的是旧 session，若不过滤
  // 会重置新角色的 y。挂载后首次 /state 落地前为 null，此时收到的帧一律忽略（见下方
  // emotion 事件处理），最坏情况只丢一帧，随后挂载的拉取会带回真值
  const ownSessionIdRef = useRef<string | null>(null)
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
  // 当前正在播放的转场，null 表示没有转场在播（与下面的锁分开存放，是两件不同的事）：
  // fall-asleep 有转场在播但不上锁（TDD「入睡转场」"不上锁，且可被交互打断"），若只留锁
  // 这一个字段来表示"转场在播"，fall-asleep 就只能把它留 null，会连带让隐藏窗口
  // （visibilitychange）判断"有没有转场在播"失效——隐藏不再终结它，转场分步定时器会在
  // 隐藏的窗口里继续推进。visibilitychange、preset-switched 清理、点击打断都应该看这个
  // 字段，不是看下面的锁
  const transitionInProgressRef = useRef<TransitionTrigger | null>(null)
  // 交互锁的绝对结束时刻（TDD「交互锁」：持续到转场的绝对结束时刻，而非倒计时）。
  // null 表示当前未锁——"没有转场在播"与"转场在播但不上锁（fall-asleep）"都属于这种情况。
  // isTransitionLocked 只依赖这个时刻与当前时钟判断，不依赖下面 transitionTimerRef 的
  // 回调是否已经触发——素材加载失败/404 不该影响锁的释放
  const transitionEndAtRef = useRef<number | null>(null)
  // 转场播放的分步定时器：每步播完后推进到下一步，最后一步播完后结束转场。preset-switched
  // 广播、隐藏窗口（visibilitychange）与卸载时都需要清掉，避免旧转场在新状态之上继续推进
  const transitionTimerRef = useRef<ReturnType<typeof setTimeout> | undefined>(undefined)
  // 点击判定的位移阈值起点坐标（TDD ⚠️「附带的误触发」）：mousedown 时记录，click 触发时
  // 与松开位置比较；null 表示这次 click 之前没有配对的 mousedown（理论上不会发生，因为
  // click 要求 down/up 落在同一元素上，留 null 只是让比较逻辑天然跳过而不是断言失败）
  const mouseDownPosRef = useRef<{ x: number; y: number } | null>(null)
  // 拖拽进行中（TDD「y 的三类占位者」瞬间交互动作一行：drag）。不进 YState——drag 属于
  // 「瞬间交互动作」这一独立类别，不是 y 的持久态第四个取值（TDD「y 的持久态取值就是
  // reservedStates 的键，逐字一致」），因此只用一个独立的布尔位，展示优先级里由
  // resolveOverlayDisplayFile 的 isDragging 参数插在转场之后、y 之前
  const isDraggingRef = useRef(false)
  // 松手时选择哪条唤醒转场，要用「抓起那一刻的 y」（TDD「唤醒与转场」是对既有规则的直接
  // 套用），不能用松手那一刻的 y——松手时会先按下面的搭理语义把 yRef 刷新回空，届时才读
  // yRef 会永远选到 poke-neutral。按下时同步捕获，松手时读出并清空
  const dragStartYRef = useRef<YState>(null)

  // 拖拽手柄的展示状态（本轮任务：原生拖动区透明带可能零宽度的补救，见 TDD「拖拽的实现
  // 方式」⚠️ 已确认发生在真机上）。用 state 而不是 ref——手柄的 opacity class 需要驱动一次
  // 真实重渲染，且不像 y/x 那样有别的渲染路径顺带带上它。悬停放大必须由这个 state + class
  // 驱动，不能指望 CSS :hover——手柄声明 -webkit-app-region: drag 后，:hover 命中会在到达
  // DOM 之前就被 WM_NCHITTEST 拦成 HTCAPTION（electron#13534），只有 class 驱动不受影响
  const [isHandleVisible, setIsHandleVisible] = useState(false)
  // 立绘 mouseLeave 后延迟隐藏手柄的一次性定时器：光标从立绘移到手柄本身也会先经过立绘的
  // mouseLeave，立即隐藏会让手柄在光标够到之前就消失，因此要等 400ms。卸载与 preset-switched
  // 都需要清掉，避免旧 preset 的隐藏定时器在新 preset 上触发
  const handleHideTimerRef = useRef<ReturnType<typeof setTimeout> | undefined>(undefined)

  // 按下一个阈值的绝对时刻调度一次性定时器（TDD「阈值表」运行期部分）。定时器到点后重新
  // 拉取 GET /state 再重算 y，而不是本地推算：它天然纠正「悬浮窗错过的用户消息」——刷新
  // 时刻靠这次拉取带回的最新 lastAttentionAt 重算，y 该维持空就维持空，绝不会先展示错误的
  // 一帧。因此复用 loadCharacterAndPortrait 本身（它拿到新数据后会再调用本函数重新调度），
  // 不另写一套。
  //
  // 注意这里**不再**是显式睡着标记的唯一到达途径：emotion 帧现在直接携带 explicitSleep
  // （见下方 emotion 监听器），困意在命中的那一轮就能生效，不必等到点重拉。定时器仍然必要，
  // 因为时长档（无聊/睡着）本身就是按时刻派生的，到点必须有人来重算一次
  function scheduleThresholdCheck(lastAttentionAt: number | null) {
    if (timerRef.current !== undefined) {
      clearTimeout(timerRef.current)
      timerRef.current = undefined
    }
    const next = nextThresholdInstant(lastAttentionAt, Date.now())
    if (next === null) return
    timerRef.current = setTimeout(() => loadCharacterAndPortrait(true), Math.max(0, next - Date.now()))
  }

  // 读取 characterId + 立绘状态（y/x）+ manifest 并应用展示——挂载时跑一次，收到
  // preset-switched 广播时跑一次，阈值定时器触发时也跑一次，转场结束时也跑一次，四处
  // 复用同一套逻辑，不各写一遍（TDD「悬浮窗重载时主动调用状态快照接口拉取当前情绪标签和
  // 立绘状态，不依赖本地缓存」）。calledByThresholdTimer 由调用方显式声明"这次调用是不是
  // 由阈值定时器发起的"（TDD「入睡转场」表格：只有运行期阈值定时器造成的迁移才播
  // fall-asleep，挂载/preset-switched/转场结束都是取快照或收尾，不算一次真实迁移）——
  // 显式传参而不是靠其它状态推断，调用点一目了然，也不会因为将来插入新调用点而漏判
  function loadCharacterAndPortrait(calledByThresholdTimer: boolean) {
    const gen = ++loadGenRef.current
    // 迁移判定要用"这次调用重新求值之前"的 y，必须在下面任何异步/重算发生之前同步取值
    const previousY = yRef.current

    fetch(`${CORE_URL}/state`)
      .then(r => r.json())
      .then((state: AppState) => {
        if (gen !== loadGenRef.current) return
        const id = state.presetSnapshot?.characterId
        if (!id) return
        setCharacterId(id)
        // 记住悬浮窗自己当前展示的会话（见上方 ownSessionIdRef 声明处的注释），供 emotion
        // 事件处理判断一帧是否还属于当前展示的角色
        ownSessionIdRef.current = state.sessionId

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
            // 阈值定时器把 y 从非睡着迁移到睡着才播入睡转场（TDD「入睡转场」表格第一行）；
            // 载入期判定到的睡着（挂载/preset-switched）与转场刚结束后的这次重新求值都不
            // 满足 shouldPlayFallAsleep，直接走下面的常规展示分支
            if (shouldPlayFallAsleep({
              calledByThresholdTimer,
              previousY,
              nextY: yRef.current,
              explicitSleep: state.explicitSleep,
            })) {
              startTransition('fall-asleep')
              return
            }
            setFile(resolveOverlayDisplayFile(manifestRef.current, transitionFileRef.current, isDraggingRef.current, yRef.current, xRef.current))
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
  // 清空转场进行中状态、锁，然后复用 loadCharacterAndPortrait 重新拉取 /state（本批次任务书
  // "refetch /state by reusing loadCharacterAndPortrait"）。这样才能拿到唤醒动作已经
  // 刷新过的 lastAttentionAt/explicitSleep，重新起链阈值定时器——portraitState.ts
  // nextThresholdInstant 的既有注释也点名调用方必须另有重新起链的入口，这里正是其一。
  // calledByThresholdTimer 传 false：转场结束是"取快照/收尾"，不是阈值定时器本身触发的
  // 迁移，不该让这次重新求值再去误播一次 fall-asleep（入睡转场自己播完的这次回拉正是
  // 需要被 shouldPlayFallAsleep 挡住的例子——此时 previousY 已经是 'sleeping'）
  function endTransition() {
    if (transitionTimerRef.current !== undefined) {
      clearTimeout(transitionTimerRef.current)
      transitionTimerRef.current = undefined
    }
    transitionFileRef.current = null
    transitionInProgressRef.current = null
    transitionEndAtRef.current = null
    setIsLocked(false)
    loadCharacterAndPortrait(false)
  }

  // 播放一条转场（TDD「唤醒与转场」+「入睡转场 fall-asleep」，四条转场共用同一份播放/
  // 锁机制）。trigger 为唤醒三条时由调用方按唤醒前的 y 选定；为 fall-asleep 时由
  // loadCharacterAndPortrait 在检测到阈值定时器把 y 迁移到睡着时调用。链条一步都解析不出
  // 素材时 resolveTransitionChain 返回空数组——按 TDD「回落规则」"不播转场，直接完成状态
  // 切换"的等价情况处理：不上锁、不播放，直接按本地已知的 y/x 完成展示，绝不能让转场把
  // 立绘卡住
  function startTransition(trigger: TransitionTrigger) {
    // 交互锁生效期间丢弃 fall-asleep（TDD「交互锁」：锁期间到达的一律丢弃，不排队）。
    // 这条挡的是一个异步竞态：阈值定时器的回调要先 await 一次 /state fetch，若在它落地之前
    // 用户已经点击/松手起了一条**上锁的**唤醒转场，那次迟到的回调仍会走到这里，而下面
    // 「fall-asleep 不上锁」那行会把 transitionEndAtRef 置成 null——锁又一次在绝对结束时刻
    // 之前被释放。唤醒三条链不需要同样的判断：它们只由点击/松手触发，而那两条路径本身
    // 已经在锁期间被丢弃了，到不了这里
    if (trigger === 'fall-asleep' && isTransitionLocked(transitionEndAtRef.current, Date.now())) {
      return
    }

    // 开新链之前先无条件取消在播的转场。这不是防御性冗余，是一条真实可达的路径：拖拽本身
    // 不刷新「上次搭理时刻」（只有松手才刷），所以拖到一半时先前排的阈值定时器照样会到点，
    // fall-asleep 就在拖拽进行中开播了——这符合 TDD「入睡转场」"不上锁、可被交互打断"。但
    // 松手时 handleDragEnd 会接着 startTransition 播唤醒/poke 链，若不先清掉旧的步进定时器，
    // 它稍后会带着自己的闭包触发 endTransition，把**新**转场的 transitionEndAtRef 一起清成
    // null 并 setIsLocked(false)——锁在绝对结束时刻之前就被释放，直接违反 TDD「交互锁」的
    // "锁的释放只依赖时刻"。点击那条打断路径本来就自己清过一次，这里上提到公共入口，
    // 让所有调用方都成立（点击分支保留它自己那次清理不冲突，clearTimeout 幂等）
    if (transitionTimerRef.current !== undefined) {
      clearTimeout(transitionTimerRef.current)
      transitionTimerRef.current = undefined
    }
    transitionInProgressRef.current = null
    transitionFileRef.current = null
    // 锁状态一并清掉再由下方按新 trigger 重新置位。走到这里时它必然已经是 null（能被
    // 取代的只有不上锁的 fall-asleep，上锁的那三条会让新交互在更外层就被丢弃），显式清一次
    // 是为了让这个不变式不必由读者自己去推导
    transitionEndAtRef.current = null
    setIsLocked(false)

    const steps = resolveTransitionChain(manifestRef.current, trigger)
    if (steps.length === 0) {
      // 不播转场时直接按本地已知状态完成切换，而不是回拉 /state：唤醒路径的调用方在唤醒时
      // 已经把 y 按"刚被搭理"更新过，而那次 POST 与这里的 GET 之间没有任何顺序保证——先到的
      // /state 可能还没反映出唤醒，立绘会表现成"点了没醒"；入睡路径的 y 本就是这次 /state
      // 拉取如实算出的迁移结果，同样不需要再拉一次。有转场的路径不受影响：3~6 秒的播放时间
      // 足够任何上报落地，所以 endTransition 那次回拉仍然照常保留
      setFile(resolveOverlayDisplayFile(manifestRef.current, null, isDraggingRef.current, yRef.current, xRef.current))
      return
    }
    transitionInProgressRef.current = trigger
    // 只有 fall-asleep 不上锁（TDD「入睡转场」"不上锁，且可被交互打断"——角色自己犯困，
    // 锁住用户三秒没有道理，反而像卡住）；其余三条唤醒转场维持既有的锁到绝对结束时刻
    transitionEndAtRef.current = trigger === 'fall-asleep' ? null : transitionEndInstant(steps, Date.now())
    // 同步刷新 .overlay-root 的拖拽区反馈（TDD「拖拽的实现方式」），不等下一次 setFile 触发
    // 的重渲染顺带算出——见上面 isLocked 声明处的注释
    setIsLocked(isTransitionLocked(transitionEndAtRef.current, Date.now()))
    playTransitionStep(steps, 0)
  }

  // 点击判定：mousedown 记录起点，click 触发时先按位移阈值过滤误触发（TDD ⚠️「附带的误
  // 触发」），再检查交互锁（锁期间一律丢弃，不排队）。锁检查之后、按 y 分支决定动作之前，
  // 还要单独拦一次"入睡转场正在播放"（TDD「入睡转场」"可被交互打断"）：fall-asleep 不
  // 上锁，但此刻 y 已经因为迁移被写成'sleeping'，若落进下面的 y 分支会被当成"唤醒点击"
  // 误播 wake-from-sleep（角色其实还没播完入睡，就先播一次醒来），因此必须单独处理，见下方
  // 分支注释。此后才是既有的 y 分支（TDD「点击小人按 y 分支」）：无聊/睡着 → 上报交互 +
  // 播放对应转场、不开聊天窗口；空 → 沿用既有的打开聊天窗口行为
  // 手柄隐藏统一走这一个函数（立绘 mouseLeave 与拖拽结束都要触发它），避免两处各写一份
  // 400ms 定时器逻辑。到点时读 isDraggingRef 判断是否要抑制隐藏（TDD 本轮任务书「拖拽进行中
  // 光标停在手柄上，立绘不会再触发 mouseEnter」）——拖拽期间到点就跳过，不隐藏也不重新调度；
  // 真正让手柄消失的是 handleDragEnd 里再次调用本函数重新起一轮 400ms
  function scheduleHandleHide() {
    if (handleHideTimerRef.current !== undefined) {
      clearTimeout(handleHideTimerRef.current)
    }
    handleHideTimerRef.current = setTimeout(() => {
      handleHideTimerRef.current = undefined
      if (isDraggingRef.current) return // 拖拽进行中，抑制隐藏，交由 handleDragEnd 重新起计时
      setIsHandleVisible(false)
    }, 400)
  }

  function handlePortraitMouseEnter() {
    if (handleHideTimerRef.current !== undefined) {
      clearTimeout(handleHideTimerRef.current)
      handleHideTimerRef.current = undefined
    }
    setIsHandleVisible(true)
  }

  function handlePortraitMouseLeave() {
    scheduleHandleHide()
  }

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

    if (transitionInProgressRef.current === 'fall-asleep') {
      // 打断入睡（TDD「入睡转场」"可被交互打断……打断后必须同时刷新'上次搭理时刻'"）：
      // 这是与下面"唤醒点击"不同的一条路径——唤醒时 y 已经是睡着，点击是要清掉它；打断时
      // y 也已经是睡着（迁移发生时就写下了），但打断不能走 wake-from-sleep，否则就是
      // TDD 点名要避免的"还没睡着就先醒一次"。打断要走完整的"搭理"语义：取消播放
      // （清定时器 + 清转场进行中状态，不锁，没有锁可释放）+ 上报交互 + 本地乐观刷新时刻，
      // y 回到空。刷新时刻是必须的，不是可选的优化：60 分钟阈值在迁移发生时已经越过，
      // 只取消播放而不刷新时刻，下一次求值立刻又是睡着，转场会原地重新触发
      if (transitionTimerRef.current !== undefined) {
        clearTimeout(transitionTimerRef.current)
        transitionTimerRef.current = undefined
      }
      transitionInProgressRef.current = null
      transitionFileRef.current = null

      fetch(`${CORE_URL}/internal/overlay-interaction`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ type: 'portrait-click' }),
      }).catch(() => {})

      const now = Date.now()
      yRef.current = deriveY({ lastAttentionAt: now, explicitSleep: false, now })
      scheduleThresholdCheck(now)
      setFile(resolveOverlayDisplayFile(manifestRef.current, null, isDraggingRef.current, yRef.current, xRef.current))
      return
    }

    if (yRef.current === 'boredom-idle' || yRef.current === 'sleeping') {
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

  // 拖拽开始（主进程转发 WM_ENTERSIZEMOVE，见 electron-api.d.ts onOverlayDragStart）。
  // fall-asleep 不上锁，因此拖拽可能在它播放途中开始（TDD「入睡转场」"不上锁，且可被交互
  // 打断"）；其余三条转场都上锁，锁着时 .overlay-root 已被 isLocked 动态切成 no-drag，
  // 窗口管理器根本不会进入原生拖动、也就不会触发这个回调，因此这里只需要处理 fall-asleep
  // 这一种"转场进行中仍能开始拖拽"的情况。此刻 yRef.current 已经是 'sleeping'——迁移发生在
  // loadCharacterAndPortrait 里、早于转场开始播放（见该函数），若照常把它当作"抓起那一刻的
  // y"，松手时会选中 wake-from-sleep，等于「还没睡着就先醒一次」，这正是打断入睡必须避免的
  // 问题（与点击打断入睡时的道理完全相同）。因此这里要撤销这次未完成的入睡：停掉转场分步
  // 定时器与转场进行中状态、把 y 拉回空。网络上报仍然只在松手时发生一次（抓起本身不是一次
  // 完成的"搭理"），这里只改本地状态
  function handleDragStart() {
    if (transitionInProgressRef.current === 'fall-asleep') {
      if (transitionTimerRef.current !== undefined) {
        clearTimeout(transitionTimerRef.current)
        transitionTimerRef.current = undefined
      }
      transitionInProgressRef.current = null
      transitionFileRef.current = null
      yRef.current = null
    }

    dragStartYRef.current = yRef.current
    isDraggingRef.current = true
    setFile(resolveOverlayDisplayFile(manifestRef.current, transitionFileRef.current, true, yRef.current, xRef.current))
  }

  // 拖拽结束（主进程转发 WM_EXITSIZEMOVE，见 electron-api.d.ts onOverlayDragEnd）。松手要做
  // 完整的搭理语义（TDD「搭理 bot 的三种交互」第一种——拖拽悬浮窗），与点击唤醒同款的本地
  // 乐观更新，理由也相同：上报与这里的本地重算之间没有顺序保证，不乐观更新会重现同一处
  // POST/GET 竞态。松手播哪条转场只看"抓起那一刻的 y"（selectTransitionTrigger 是对既有
  // 规则的直接套用），不是这里刚刷新出的空——如果读刷新后的 yRef 会永远选到 poke-neutral
  function handleDragEnd() {
    isDraggingRef.current = false
    // 拖拽期间被抑制的隐藏没有自然的后续触发点（光标停在手柄上，立绘不会再收到 mouseEnter/
    // mouseLeave），松手后必须在这里重新起一轮 400ms，否则手柄会永远停在放大态
    scheduleHandleHide()
    const capturedY = dragStartYRef.current
    dragStartYRef.current = null

    fetch(`${CORE_URL}/internal/overlay-interaction`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ type: 'drag-end' }),
    }).catch(() => {})

    const now = Date.now()
    yRef.current = deriveY({ lastAttentionAt: now, explicitSleep: false, now })
    scheduleThresholdCheck(now)

    startTransition(selectTransitionTrigger(capturedY))
  }

  useEffect(() => {
    loadCharacterAndPortrait(false)
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
      if (handleHideTimerRef.current !== undefined) {
        clearTimeout(handleHideTimerRef.current)
      }
    }
  }, [])

  // 悬浮窗隐藏即终结转场（TDD「交互锁」必须由构造保证的性质第二条：隐藏不等于唤醒，只
  // 终结转场本身，不触碰持久条件状态）；有锁的转场一并释放锁，fall-asleep 本来就没上锁，
  // 隐藏对它而言只是把播放中断掉。用 document.visibilityState 而不是监听 Electron 窗口
  // 事件：BrowserWindow.hide()（主进程 overlay:activate / win.on('focus') 都会触发）会让
  // 渲染进程的 visibilityState 变成 hidden，这是纯 Web 标准事件，不需要额外的 IPC 通道。
  // 判断要看 transitionInProgressRef 而不是下面的锁——fall-asleep 播放期间锁恒为 null，
  // 若还用锁判断"有没有转场在播"，隐藏窗口时就不会终结它，转场分步定时器会在隐藏的窗口里
  // 继续推进。只有确实有转场在播放时才需要处理，没有转场时隐藏不做任何事——没有锁可释放，
  // 也不该无谓地重新拉取 /state
  useEffect(() => {
    function handleVisibilityChange() {
      if (document.visibilityState !== 'hidden') return
      // 拖拽态与转场一并收尾：正常情况下 Win32 的移动模态循环在松手时总会送出
      // WM_EXITSIZEMOVE，所以这里多半不会有事可做；但万一那条信号没到达（窗口在拖拽中途被
      // 隐藏），isDraggingRef 会一直为真、立绘永久停在 drag 素材上。与下面的转场收尾对称地
      // 清掉，兜住这种情况——不触碰持久条件状态（y 是睡着时看一眼聊天窗再回来仍应是睡着）
      const wasDragging = isDraggingRef.current
      isDraggingRef.current = false
      dragStartYRef.current = null
      if (transitionInProgressRef.current !== null) {
        endTransition()
      } else if (wasDragging) {
        // 有转场在播时上面的 endTransition 会顺带回拉 /state 并重绘；没有转场、只是拖拽被
        // 隐藏打断这一支没有任何重绘入口，而 handleDragStart 早已把立绘换成 drag 素材了，
        // 不补这一次就会在窗口重新显示后一直停在拖拽帧上，直到下一次自然的重新求值
        setFile(resolveOverlayDisplayFile(manifestRef.current, null, false, yRef.current, xRef.current))
      }
    }
    document.addEventListener('visibilitychange', handleVisibilityChange)
    return () => {
      document.removeEventListener('visibilitychange', handleVisibilityChange)
    }
  }, [])

  // 拖拽起止的 IPC 订阅（另一位 agent 已在主进程/preload 完成，本文件只消费）。只在挂载时
  // 注册一次——handleDragStart/handleDragEnd 全部通过 ref 读写状态，不闭包捕获会过期的
  // state，因此不需要放进依赖数组重新订阅
  useEffect(() => {
    const unsubscribeStart = window.electronAPI.onOverlayDragStart(handleDragStart)
    const unsubscribeEnd = window.electronAPI.onOverlayDragEnd(handleDragEnd)
    return () => {
      unsubscribeStart()
      unsubscribeEnd()
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

        // 一帧是否属于悬浮窗当前展示的会话，由 sessionId 判断，不属于就整段跳过——不更新
        // x、不重算 y、不重新调度、不清 dragStartYRef（TDD §3.3「emotion」行：sessionId 供
        // 前端识别这帧是否还属于当前展示的会话）。这条挡的是一个真实竞态：一次在 preset
        // 切换前发起、切换后才跑完的模型调用，其 emotion 帧带的是旧 session，若不过滤就会
        // 用旧角色的这次更新去重置新角色的 y。ownSessionIdRef 还是 null（挂载后首次 /state
        // 尚未落地）时同样忽略——此时无法判断归属，宁可丢一帧，随后挂载的那次拉取会带回真值
        // 并重建全部状态
        if (ownSessionIdRef.current === null || data.sessionId !== ownSessionIdRef.current) return

        // 记录最新的 x，使 y → x 回落总是落到"最新的" x，而不是进入 y 之前那个（TDD「两者是
        // 平级的状态机……y 展示期间 x 照常更新，y 消失后落到的是最新的 x」）。
        // 按「self 键在不在」判断：键不存在意味着这一帧不携带任何 x 信息（后端在 label 为
        // sleep 那一轮省掉了它），此时必须保留原有的 x 不动；键存在但值为 null 才是既有的
        // 「本轮解析不出合法情绪」降级，照旧把 x 清空
        if ('self' in data) {
          xRef.current = data.self?.label
        }

        // lastAttentionAt 仍然只能推断，但推断本身依旧成立：帧只由 services/core/routes/
        // chat.ts 在处理一轮用户消息时发出，那条路径必定先调过 recordAttention，因此
        // lastAttentionAt ≈ 现在。explicitSleep 不再靠推断——它现在由这一帧显式携带（chat.ts
        // 在发帧前实时读取 isExplicitSleep(sessionId)），直接使用即可。此前"收到帧就等于
        // 本轮不是 sleep、显式睡着标记必为 false"的假设已经不成立：困意改为从回复正文检测
        // 后（TDD §3.9），一条完全正常、照常发帧的回复也可能在文本里命中困意规则并置位显式
        // 睡着标记；真正不发这帧的只有 self.label === 'sleep' 那条独立分支（x 永不为 sleep
        // 的守卫），两者是不同的判定，不能再共用同一个"收到帧 ⇒ 醒着"的结论。不重新拉取
        // GET /state 的理由不变：buildStatePayload 会顺带做 Ollama / embedding 健康检查，
        // 每轮对话都拉一次太重，且这两个值现在都能从帧本身直接得到，不需要再问一次后端。
        // scheduleThresholdCheck 仍然必须重新调度：定时器是 y 唯一的自愈通道，而它在「会话
        // 还没有任何历史消息」（无时长基准）和「已经走到 60 分钟睡着档」（没有下一层阈值）
        // 两种情况下都不会被调度，缺了这里就会出现"用户正在聊天、悬浮窗却一直停在无聊/睡着"
        // 的死锁
        const now = Date.now()
        yRef.current = deriveY({ lastAttentionAt: now, explicitSleep: data.explicitSleep, now })
        scheduleThresholdCheck(now)
        // 这一帧同时让拖拽开始时捕获的 y 作废。理由不是「角色此刻已经醒着」——explicitSleep
        // 现在可能随这一帧变成 true，角色完全可能是真困了。真正的理由是：松手本身就是「搭理
        // bot」的三种交互之一，handleDragEnd 会无条件刷新时刻并上报 drag-end（服务端同时清掉
        // 显式睡着标记），所以抓起来那一刻的 y 已经不再是选唤醒链的合理依据。若不清，
        // 「拖拽途中用户又在聊天窗发了条消息」
        // 这种并发情形下，松手仍会按陈旧的 sleeping / boredom-idle 播一次多余的唤醒动画
        // （还会连带上锁 3~6 秒）。清成 null 后 selectTransitionTrigger 落到 poke-neutral，
        // 与「本来就醒着时拖拽」同一条规则
        dragStartYRef.current = null

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
        setFile(resolveOverlayDisplayFile(manifestRef.current, transitionFileRef.current, isDraggingRef.current, yRef.current, xRef.current))
      } catch {
        // 忽略解析失败的事件，保留当前已展示的立绘
      }
    })
    source.addEventListener('preset-switched', () => {
      // 新角色的 manifest/立绘状态到达前先清空展示，避免新角色的情绪标签下短暂闪出
      // 旧角色的立绘（旧 file 对新角色的 emotions 词表大概率无意义，即使凑巧同名也是误导）。
      // 同时清掉旧 preset 的阈值定时器、转场分步定时器、转场进行中状态与交互锁，以及
      // y/x——旧 preset 的转场引用的是旧角色包的素材路径，继续播放会对着新 characterId
      // 请求错误的文件，锁也没有理由继续拦截新 preset 上的交互
      if (timerRef.current !== undefined) {
        clearTimeout(timerRef.current)
        timerRef.current = undefined
      }
      if (transitionTimerRef.current !== undefined) {
        clearTimeout(transitionTimerRef.current)
        transitionTimerRef.current = undefined
      }
      transitionFileRef.current = null
      transitionInProgressRef.current = null
      transitionEndAtRef.current = null
      setIsLocked(false)
      isDraggingRef.current = false
      dragStartYRef.current = null
      // 拖拽手柄的隐藏定时器同样不能跨 preset 存活，否则旧 preset 挂起的一次隐藏会在新
      // preset 上触发（虽然手柄本身与角色无关，但计时器生命周期仍应随一次性清理统一收尾）
      if (handleHideTimerRef.current !== undefined) {
        clearTimeout(handleHideTimerRef.current)
        handleHideTimerRef.current = undefined
      }
      setIsHandleVisible(false)
      manifestRef.current = undefined
      yRef.current = null
      xRef.current = undefined
      // 与其它按会话的状态一起清掉，保持「会话未知或不匹配 ⇒ 丢弃」这条不变式对称。
      // 不清的话，在这次 /state 落地之前 ownSessionIdRef 仍是**旧**会话号，旧会话的迟到
      // 帧反而会通过过滤（与挂载时 null 一律丢弃恰好相反）。当前这段窗口里 manifestRef
      // 为空、不会渲染出来，所以只是防御；但别让这条不变式依赖执行顺序的巧合成立
      ownSessionIdRef.current = null
      setFile(null)
      loadCharacterAndPortrait(false)
    })
    return () => {
      source.close()
    }
  }, [])

  const src = file && characterId ? resolveAssetUrl(characterId, file) : null

  return (
    <div className={`overlay-root${isLocked ? ' overlay-root--locked' : ''}`}>
      {/* 点击恢复要挂在立绘本体上，不能挂在 overlay-root：root 整体是
          -webkit-app-region: drag，Windows 下拖动区域在 DOM 收到事件之前就被
          WM_NCHITTEST 拦成 HTCAPTION，普通 click 根本派发不到——立绘单独标记
          no-drag 才能正常收到点击，同时 root 上没被立绘盖住的部分仍然可拖动。
          交互锁期间（overlay-root--locked，见 overlay.css）root 被动态改回 no-drag，
          让转场进行中彻底禁止拖拽（TDD「拖拽的实现方式」"比在渲染层忽略事件更彻底"） */}
      {src && (
        <img
          className="overlay-portrait"
          src={src}
          alt=""
          onMouseDown={handleMouseDown}
          onClick={handlePortraitClick}
          onMouseEnter={handlePortraitMouseEnter}
          onMouseLeave={handlePortraitMouseLeave}
        />
      )}
      {/* 专属拖拽手柄（TDD「拖拽的实现方式」⚠️ 透明拖拽带零宽度风险已在真机确认发生）：
          近方形立绘吃满 max-width/height 100% 时，root 上没被立绘盖住的可拖区域宽度为 0，
          唯一还留着的可拖区就是这个固定 20px 圆形角标。始终挂载在 DOM 里（只用 opacity 切换
          可见度），不透明度不影响命中区——手柄淡出后原地仍可拖，可见度只是提示不是开关。
          .overlay-root--locked 时被下面 CSS 覆盖为 no-drag，见 overlay.css 顶部注释 */}
      <div
        className={`overlay-drag-handle${isHandleVisible ? ' overlay-drag-handle--visible' : ''}`}
      />
    </div>
  )
}
