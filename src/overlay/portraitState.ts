// 悬浮窗立绘状态模型的纯函数部分（docs/MintBot_TDD.md §3.7 附「悬浮窗立绘状态模型」）：
// y 的求值顺序（本批次只实现「显式睡着标记」与「阈值表」两层，转场/拖拽留给批次 3、4，
// 不为它们预留占位字段）、下一阈值绝对时刻的计算、以及 y/x 两台平级状态机之间的展示优先级
// 与素材回落链。本文件不含任何 DOM / fetch / 定时器副作用，因此可以在 node 环境下直接单测——
// vitest.config.ts 的 include 覆盖 **/*.test.ts，这个仓库没有渲染层测试基础设施，把逻辑收在
// 纯函数模块里是唯一可测的办法。OverlayApp.tsx 是薄的接线层，只负责 fetch/EventSource/
// setTimeout 等副作用，调用本模块。

// 两个阈值写死为常量，不做用户可配置项——可配置会让这套行为失去被发现的意外感（TDD 原文）
export const BOREDOM_THRESHOLD_MS = 15 * 60 * 1000
export const SLEEP_THRESHOLD_MS = 60 * 60 * 1000

// y 的三类占位者（TDD「y 的三类占位者」）本批次只实现「持久条件状态」里的无聊/睡着两个
// 成员；瞬间交互动作（drag）与转场序列不在本批次范围内，故此类型不为它们留分支
export type YState = 'boredom-idle' | 'sleeping' | null

// manifest schema v3（docs/MintBot_TDD.md「立绘资源管理」）本悬浮窗用得到的最小形状。
// 除 avatar 外全部字段可选，渲染层不共享 services/core/characters/manifest.ts 的
// CharacterManifest 类型（那是后端内部模块，且 GET /characters/*/manifest.json 是
// @fastify/static 原样返回磁盘文件，没有经过后端自己的 mergeManifest 按字段兜底默认值——
// 渲染层拿到的可能是没填全的手写 manifest），只本地声明这里用得到的最小形状，且
// emotions 也按可选处理——与 src/settings/CharacterPanel.tsx / src/chat/ChatWindow.tsx
// 里对 manifest.json 的局部类型声明同一约定。这一批新增 reservedStates，用于无聊态取材
// （TDD「y 的三类占位者」reservedStates 一行）
export interface PortraitForm {
  fallback: string
  emotions?: Record<string, string[]>
}

export interface OverlayManifest {
  portraits?: {
    pixel?: PortraitForm
  }
  reservedStates?: Record<string, string[]>
  // 转场链条声明（schema v3「transitions」小节）。类型定为 unknown 而非具体的步骤形状：
  // 这是手写 manifest 里最容易写错的一块（from 可以是字符串或数组、durationMs 可能漏填），
  // 由 src/overlay/transitionState.ts 逐步做防御性解析，本文件的最小形状声明不替它预先假定
  // 结构是合法的
  transitions?: Record<string, unknown>
}

// 本批次起被 transitionState.ts 复用（转场每一步「来源内随机挑一个」与「多个来源间随机挑一个」
// 是同一个操作），因此导出
export function pickRandom<T>(items: T[]): T {
  return items[Math.floor(Math.random() * items.length)]
}

// y 的求值（TDD「y 的求值顺序」，本批次只实现下面两层——转场进行中/拖拽进行中留给批次 3、4）：
// 有显式睡着标记 → 睡着；以上都没有 → 按「距上次搭理 bot」查阈值表。lastAttentionAt 为
// null（会话没有任何历史消息）时不当作"无穷久以前"，直接判定 y 为空（TDD「无任何历史消息：
// y 与 x 均为空」）。阈值表运行期与载入期共用同一张（TDD「阈值表」），调用方在挂载/
// preset 切换/定时器触发这三个时机传入不同的 now 与 lastAttentionAt 即可复用同一函数
export function deriveY(params: {
  lastAttentionAt: number | null
  explicitSleep: boolean
  now: number
}): YState {
  if (params.explicitSleep) return 'sleeping'
  if (params.lastAttentionAt === null) return null
  const elapsed = params.now - params.lastAttentionAt
  if (elapsed >= SLEEP_THRESHOLD_MS) return 'sleeping'
  if (elapsed >= BOREDOM_THRESHOLD_MS) return 'boredom-idle'
  return null
}

// 下一个阈值的绝对时刻（TDD「应按下一个阈值的绝对时刻调度一次性定时器，而不是轮询」）。
// 只依据 lastAttentionAt 与阈值表本身，不看 explicitSleep——显式睡着标记没有自己的到期
// 时刻，它只能被"搭理 bot"清除，而清除它的那条路径（聊天窗口发消息）会让调用方收到一帧
// emotion 事件并据此重新调度，不需要为它单独计时。lastAttentionAt 为 null（无历史消息）时
// 没有时长基准，不调度；已经过 60 分钟阈值时同样不调度——之后不再有下一层。这两种"不调度"
// 意味着定时器链条会在此断掉，因此调用方必须另有重新起链的入口（见 OverlayApp.tsx 的
// emotion 事件处理），不能把定时器当成唯一的自愈通道
export function nextThresholdInstant(lastAttentionAt: number | null, now: number): number | null {
  if (lastAttentionAt === null) return null
  const boredomAt = lastAttentionAt + BOREDOM_THRESHOLD_MS
  if (now < boredomAt) return boredomAt
  const sleepAt = lastAttentionAt + SLEEP_THRESHOLD_MS
  if (now < sleepAt) return sleepAt
  return null
}

// x 的素材：找不到 label 对应的素材则回落到该形态自己声明的 fallback 标签（TDD「素材回落链」
// 写作 portraits.pixel.emotions.idle，但「portraits」小节写的是"回落到该形态自己声明的
// fallback 标签"；两份角色包都把 fallback 声明为 "idle"，因此遵照声明字段而非写死 "idle"
// 字符串同时满足两种读法，也是这个函数在批次一之前的既有行为，这里原样保留）。emotions
// 本身可能缺失（手写 manifest 只声明了 fallback 没声明 emotions 的中间态），用 ?? {} 兜底
function selectXFile(pixel: PortraitForm | undefined, x: string | undefined): string | null {
  if (!pixel) return null
  const emotions = pixel.emotions ?? {}
  const candidates = (x ? emotions[x] : undefined) ?? emotions[pixel.fallback]
  if (!candidates || candidates.length === 0) return null
  return pickRandom(candidates)
}

// y 当前对应的素材来源（TDD「y 的三类占位者」「素材回落链」）：y 的持久态取值就是
// reservedStates 的键，逐字一致（TDD 原文「这不是巧合而是约束」）——取材因此是一次直接
// 查表，不是按状态分支的 switch。sleeping 的素材现在也归 reservedStates（不再是
// portraits.pixel.emotions.sleep——那个键已随 emotionVocabulary 一起移除，见「立绘资源
// 管理」"emotions 里没有 sleep，这是有意的"），因此本函数对 boredom-idle/sleeping 一视同仁；
// 将来新增 thinking/listening-to-music 时这里一行都不用改
function selectYFile(manifest: OverlayManifest, y: YState): string | null {
  if (y === null) return null
  const candidates = manifest.reservedStates?.[y]
  if (!candidates || candidates.length === 0) return null
  return pickRandom(candidates)
}

// 展示规则 + 素材回落链的完整组合（TDD「展示规则」「素材回落链」）：
//   y 有对应素材 → 用 y
//   y 没有       → 用 x
//   x 也没有     → 该形态声明的 fallback 标签，随机取一
//   fallback 也没有 → 空白（返回 null，悬浮窗保持透明，不报错不崩）
// manifest 允许为 undefined（核心服务未就绪、或 manifest.json 还没加载完成的中间态）
export function resolveDisplayFile(manifest: OverlayManifest | undefined, y: YState, x: string | undefined): string | null {
  if (!manifest) return null
  const yFile = y !== null ? selectYFile(manifest, y) : null
  if (yFile) return yFile
  return selectXFile(manifest.portraits?.pixel, x)
}
