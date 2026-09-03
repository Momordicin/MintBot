import React, { useEffect, useRef, useState } from 'react'
import type { AppState } from '../../shared/types/index.js'
import './overlay.css'

const CORE_URL = 'http://127.0.0.1:3000'

// manifest schema v2（docs/MintBot_TDD.md §3.7「立绘资源管理（manifest schema v2）」）
// 除 avatar 外全部字段可选，渲染层不共享 services/core/characters/manifest.ts 的
// CharacterManifest 类型（那是后端内部模块，且 GET /characters/*/manifest.json 是
// @fastify/static 原样返回磁盘文件，没有经过后端自己的 mergeManifest 按字段兜底默认值——
// 渲染层拿到的可能是没填全的手写 manifest），只本地声明这里用得到的最小形状，且
// emotions 也按可选处理——与 src/settings/CharacterPanel.tsx / src/chat/ChatWindow.tsx
// 里对 manifest.json 的局部类型声明同一约定
interface PortraitForm {
  fallback: string
  emotions?: Record<string, string[]>
}

interface CharacterManifestPixel {
  portraits?: {
    pixel?: PortraitForm
  }
}

// GET /events 的 emotion 事件负载：广播端（services/core/routes/chat.ts）在没有
// 有效情绪解析结果时会广播 self: null，与 shared/types 里 EmotionState.self 声明为
// 非空的 EmotionLabel 不完全一致——本地按实际观察到的运行时形状定义，不强改共享类型
interface EmotionEventPayload {
  self: { label: string; intensity: number } | null
  perceived_user: unknown
}

function pickRandom<T>(items: T[]): T {
  return items[Math.floor(Math.random() * items.length)]
}

// 展示逻辑：emotions[label] → emotions[fallback] → 都没有则不展示（返回 null，
// 悬浮窗保持透明空白，不报错不崩），见计划「展示逻辑」一节。emotions 本身可能缺失
// （手写 manifest 只声明了 fallback 没声明 emotions 的中间态），用 ?? {} 兜底，
// 不能假设它一定存在
function selectPortraitFile(pixel: PortraitForm | undefined, label: string | undefined): string | null {
  if (!pixel) return null
  const emotions = pixel.emotions ?? {}
  const candidates = (label ? emotions[label] : undefined) ?? emotions[pixel.fallback]
  if (!candidates || candidates.length === 0) return null
  return pickRandom(candidates)
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
  // pixel 随 preset-switched 广播刷新（见下方 loadCharacterAndPortrait），用 ref 存它是为了
  // 让 EventSource 的 emotion 事件回调（只在挂载时注册一次，见下一个 effect）每次都能读到
  // 最新值，而不是闭包捕获注册那一刻的旧值
  const pixelRef = useRef<PortraitForm | undefined>(undefined)
  // 用递增的"代次"而不是一次性的布尔值来识别过期回调：loadCharacterAndPortrait 可能被
  // 多次调用（挂载一次 + 每次 preset-switched 广播各一次），任何一次调用的异步回调都必须
  // 只在"仍然是发起时那一代"时才生效——否则布尔值一旦被卸载清理函数置为已失效，
  // React.StrictMode（src/overlay/main.tsx）开发环境下的"挂载→卸载→再挂载"探测性双调用
  // 会让它永远卡在失效状态，之后真正的那次挂载和所有 preset-switched 触发的重新加载都会
  // 直接被当成过期请求丢弃；同理，两次 preset-switched 挨得很近时，后一次发起的调用也需要
  // 能让前一次仍在途的回调作废，不能靠一个共享的布尔值区分"谁是最新的那次"
  const loadGenRef = useRef(0)

  // 读取 characterId + 当前情绪标签 + manifest 并应用展示——挂载时跑一次，收到 preset-switched
  // 广播时也复用同一套逻辑重新跑一次（见下面的 effect），不在两处各写一遍
  function loadCharacterAndPortrait() {
    const gen = ++loadGenRef.current

    fetch(`${CORE_URL}/state`)
      .then(r => r.json())
      .then((state: AppState) => {
        if (gen !== loadGenRef.current) return
        const id = state.presetSnapshot?.characterId
        if (!id) return
        setCharacterId(id)

        return fetch(`${CORE_URL}/characters/${encodeURIComponent(id)}/manifest.json`)
          .then(r => r.json())
          .then((manifest: CharacterManifestPixel) => {
            if (gen !== loadGenRef.current) return
            pixelRef.current = manifest.portraits?.pixel
            setFile(selectPortraitFile(pixelRef.current, state.emotion?.self?.label))
          })
      })
      .catch(() => {
        // 核心服务未就绪/不可达：悬浮窗保持透明空白，不重试、不报错
      })
  }

  useEffect(() => {
    loadCharacterAndPortrait()
    // 卸载时把代次再往前推一格，让挂载期间任何仍在途的回调都识别为过期——不需要额外的
    // 布尔标记，判断逻辑与"被更新的一次调用取代"完全一样，天然覆盖卸载这一种情况
    return () => {
      loadGenRef.current++
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
        // 每次收到事件都直接重新挑选一次文件，不依赖"情绪标签文本是否变化"——
        // 连续多轮情绪标签相同时也要有机会随机换一个变体展示，这正是 manifest 里
        // emotions 数组"多变体随机展示"设计的意义所在（TDD §3.7）。如果改成先
        // setState 情绪标签、再靠 useMemo 按标签是否变化决定要不要重挑，标签没变时
        // React 会因为状态相等而跳过重渲染，导致立绘永远卡在第一次选中的那个变体上
        setFile(selectPortraitFile(pixelRef.current, data.self?.label))
      } catch {
        // 忽略解析失败的事件，保留当前已展示的立绘
      }
    })
    source.addEventListener('preset-switched', () => {
      // 新角色的 manifest/情绪标签到达前先清空展示，避免新角色的情绪标签下短暂闪出
      // 旧角色的立绘（旧 file 对新角色的 emotions 词表大概率无意义，即使凑巧同名也是误导）
      pixelRef.current = undefined
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
      {src && <img className="overlay-portrait" src={src} alt="" />}
    </div>
  )
}
