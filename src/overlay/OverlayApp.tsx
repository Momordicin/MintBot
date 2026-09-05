import React, { useEffect, useRef, useState } from 'react'
import type { AppState } from '../../shared/types/index.js'
import './overlay.css'
import {
  type OverlayManifest,
  type YState,
  deriveY,
  nextThresholdInstant,
  resolveDisplayFile,
} from './portraitState.js'

const CORE_URL = 'http://127.0.0.1:3000'

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
            setFile(resolveDisplayFile(manifestRef.current, yRef.current, xRef.current))
          })
      })
      .catch(() => {
        // 核心服务未就绪/不可达：悬浮窗保持透明空白，不重试、不报错
      })
  }

  useEffect(() => {
    loadCharacterAndPortrait()
    // 卸载时把代次再往前推一格，让挂载期间任何仍在途的回调都识别为过期——不需要额外的
    // 布尔标记，判断逻辑与"被更新的一次调用取代"完全一样，天然覆盖卸载这一种情况。同时
    // 清掉阈值定时器，避免组件已卸载后它还触发一次 loadCharacterAndPortrait
    return () => {
      loadGenRef.current++
      if (timerRef.current !== undefined) {
        clearTimeout(timerRef.current)
      }
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
        // 有条件的……在上面的求值模型下自动成立」）
        setFile(resolveDisplayFile(manifestRef.current, yRef.current, xRef.current))
      } catch {
        // 忽略解析失败的事件，保留当前已展示的立绘
      }
    })
    source.addEventListener('preset-switched', () => {
      // 新角色的 manifest/立绘状态到达前先清空展示，避免新角色的情绪标签下短暂闪出
      // 旧角色的立绘（旧 file 对新角色的 emotions 词表大概率无意义，即使凑巧同名也是误导）。
      // 同时清掉旧 preset 的阈值定时器与 y/x，避免它们在新 preset 之上继续生效
      if (timerRef.current !== undefined) {
        clearTimeout(timerRef.current)
        timerRef.current = undefined
      }
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
          onClick={() => window.electronAPI.activateFromOverlay()}
        />
      )}
    </div>
  )
}
