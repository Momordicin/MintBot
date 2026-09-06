// 把 theme.ts 产出的 ThemeColors 接到聊天窗口消费方的一层薄适配：
// ① 'auto' 解析成 'day'/'night'（theme.ts 明确不处理，交给这一层）；
// ② 新角色 → CSS 变量的映射表，落成一个纯函数（输入 ThemeColors，输出 ChatWindow.tsx
//    要下发的 CSS 变量），本文件唯一的、可以脱离 DOM 单测覆盖的逻辑，见 themeVars.test.ts；
// ③ 原生窗口按钮条带 { color, symbolColor } 的派生，同样是纯函数。
//
// 本文件不依赖 DOM/React，供 ChatWindow.tsx 消费。
import type { AlphaColor, RgbTuple, ThemeColors, ThemeInput, ThemeMode } from './theme.js'

// displayConfig 缺失时（v7 之前创建的历史冻结快照）的主题输入兜底值，与
// services/core/session/displayConfig.ts 的 DEFAULT_DISPLAY_CONFIG 字面保持一致——
// 两边各自维护一份是有意的（渲染层不依赖 services/core 的模块，跟渲染层其它 DTO 一样
// 按自己的约定本地重复定义，见 DIV-009）。mode 故意不用 'auto'、固定给 'night'：
// 这条兜底路径本来就是为了让「自绘 CSS 变量」与「IPC 下发的原生按钮条带」两层收敛到
// 同一个答案，如果这里跟着 prefersDark 走，legacy 会话在两次运行之间会因为系统深浅色
// 模式不同而呈现不一样的默认外观，而 CSS `:root` 里的静态兜底值是不可能跟着联动的——
// 固定 'night' 才能保证这条兜底路径本身是确定性的。
//
// 放在这里而不是 ChatWindow.tsx：这是个不依赖 React 的纯值，纯函数测试要用到它，
// 从 .tsx 里 import 会把 React 一起拖进来。
//
// 注意：早前这里写着「global.css `:root` 的字面值必须等于 deriveTheme(DEFAULT_THEME_INPUT)
// 的输出，并有一条读 global.css 的回归测试钉住它」——**两句都已经不成立**。CSS 变量现在
// 无条件写在 document.documentElement 上，内联值恒定压过 `:root`，所以那条等式不再是要求；
// 那条测试也从来没有真正落地（vitest 默认不处理 CSS，`?raw` 拿到的是空串）。`:root` 现在
// 只是 React 挂载前那一瞬的占位，值合理即可，不需要跟任何东西对齐
export const DEFAULT_THEME_INPUT: ThemeInput = {
  accentRgb: [0, 122, 255],
  mode: 'night',
  tintStrength: 0,
}

/** displayConfig 缺失时的壁纸不透明度兜底值，与 services/core 的 DEFAULT_DISPLAY_CONFIG
 *  一致。与 DEFAULT_THEME_INPUT 一起构成「legacy 冻结快照」这条路径的完整输入 */
export const DEFAULT_CHAT_BG_OPACITY = 0.65

/** 'auto' 由调用方（这一层）解析成具体的 'day'/'night'，theme.ts 的 deriveTheme 不处理
 * 'auto'。渲染层用 window.matchMedia('(prefers-color-scheme: dark)') 的 matches 结果
 * 作为 prefersDark 输入，并订阅其 change 事件保持跟随系统实时切换（Electron 的
 * nativeTheme 驱动这个查询） */
export function resolveThemeMode(configuredMode: 'day' | 'night' | 'auto', prefersDark: boolean): ThemeMode {
  return configuredMode === 'auto' ? (prefersDark ? 'night' : 'day') : configuredMode
}

function rgbTriplet([r, g, b]: RgbTuple): string {
  return `${r}, ${g}, ${b}`
}

function rgbString(rgb: RgbTuple): string {
  return `rgb(${rgbTriplet(rgb)})`
}

function alphaColorToRgba({ base, alpha }: AlphaColor): string {
  const [r, g, b] = base
  return `rgba(${r}, ${g}, ${b}, ${alpha})`
}

/** 把一个 AlphaColor 的 alpha 抬高固定增量（钳到 1），base 不变——只用于"同一个角色，
 * hover/active 时需要比自己的静止态更显眼"这一类场景，且该角色本身已经是同族里 alpha
 * 最高的一档、没有更强的相邻角色可换（例如 fill1 已经是三档 fill 里最深的一档，
 * scrollbar-thumb 的 hover 状态没有 fill0 可用）。增量本身是本项目自定的具体数值，
 * 规格没有给、参考实现/Material 也没有对应数值 */
function boostAlpha({ base, alpha }: AlphaColor, boost: number): AlphaColor {
  return { base, alpha: Math.min(1, alpha + boost) }
}

const SCROLLBAR_THUMB_HOVER_ALPHA_BOOST = 0.15

// 自绘标题栏 / 输入栏底色的材质配方——本项目自定，不是参考发布值，也不是社区互证出来
// 的数字，是这次重写自己选的：厚模糊（毛玻璃）+ 色彩叠加（bg2 tint）+ 饱和度提升，参考的
// 是 Windows Acrylic 这一类系统级"材质"的通用配方，而这类材质的具体数值上游都不公开，因此
// 这里的 12px / 180% / 0.65 都是本次实现直接选定的（TDD §3.7 附原先记录的「chrome 不
// 透明度 0.40」是上一代纯色模型的调整史，本次改成毛玻璃材质后不再适用，替换为这组新数字）
export const CHROME_MATERIAL_ALPHA = 0.65

/** ChatWindow.tsx 下发到 document.documentElement 上的全部主题 CSS 变量（见 ChatWindow.tsx
 * 里为什么挂在 documentElement 而不是聊天窗口根 div 上的说明）。变量名与旧模型
 * （chromeColor.ts / global.css）不完全一致——见本次改动的「旧变量 → 新角色」映射表
 * （PR 说明），这里只放新变量名，不维护向后兼容别名。
 *
 * 一部分变量名沿用了上一代模型（--titlebar-bg / --input-bg / --bubble-bot-bg 等）：
 * src/settings/CharacterPanel.tsx 的主题实时预览与 src/settings/settings.css 消费的是
 * 同一批变量名（见那两个文件里的说明），设置窗口这一侧本次不改动，因此这批名字必须保持
 * 不变，只换它们背后的取值来源（新角色 + 新配方）。真正全新的变量（fill/label 分档、
 * accent、error 家族、bg2 原始三元组）由 chat.css 与 settings.css 共同消费 */
export interface ThemeCssVars {
  '--window-bg-rgb': string
  '--bg2-rgb': string
  '--chat-bg-opacity': string
  '--bubble-bot-bg': string
  '--bubble-user-bg': string
  '--bubble-bot-text': string
  '--bubble-user-text': string
  '--titlebar-bg': string
  '--input-bg': string
  '--titlebar-text': string
  '--input-text': string
  '--input-placeholder': string
  '--input-border': string
  '--text-secondary': string
  '--system-msg-text': string
  '--scrollbar-thumb': string
  '--scrollbar-thumb-hover': string
  '--label': string
  '--label2': string
  '--label3': string
  '--label4': string
  '--fill1': string
  '--fill2': string
  '--fill3': string
  '--accent': string
  '--accent-rgb': string
  '--error': string
  '--on-error': string
  '--error-container': string
  '--on-error-container': string
}

/** theme + chatBgOpacity（displayConfig 里跟主题模型无关的那个独立字段，原样透传）
 * → 完整的 CSS 变量集合。
 *
 * 气泡不透明（本次决策：气泡是阅读面，不透壁纸，见 PR 说明「气泡不透明」段），
 * bubbleOut 上恒叠 labelOnAccent（纯白）而不是 label——day 模式下 label 是纯黑，叠到
 * outgoing 气泡上会悄悄破坏 clampAccentForBubble 的白字对比度保证。bubbleIn 是中性
 * 表面，文字用随模式翻转的 label。
 *
 * --titlebar-bg / --input-bg 不再是"中性表面 + 固定 0.40 alpha"的纯色，而是材质配方的
 * 一半（另一半 backdrop-filter 的 blur/saturate 写在 chat.css 里，纯 CSS、不需要
 * 经过这里）：bg2 按 CHROME_MATERIAL_ALPHA 合成出的半透明色，配合 --bg2-rgb 这个原始
 * 三元组给 chat.css 的"材质失效时退化为不透明纯色"兜底路径用。
 *
 * accent 在 ThemeColors 里没有一个独立、未经处理的角色——theme.ts 只导出 bubbleOut
 * （经 clampAccentForBubble 钳制过的强调色，见 theme.ts 顶部注释）。这里把 bubbleOut
 * 复用为"这一层"消费的 accent：它本来就同时满足"与白字可读"和"与背景可区分"两条约束，
 * 拿来做 caret-color / accent-color / :focus-visible 轮廓 / 输入框聚焦边框 / 选中背景
 * 这些同样要求"在任意背景上都能看清"的场景，语义是通的，且不需要为此让 theme.ts 再多
 * 导出一个未钳制的原始 accent 角色。
 *
 * ⚠️ 这里的适用范围比钳制被证明的范围宽，复审指出过，如实记下：clampAccentForBubble 的
 * 两条约束只对该模式**不透明的原始 bg**（纯白 / 纯黑）证明过，而上面这些用法压在的是
 * fill3、以及叠在任意壁纸之上的半透明材质。复审实测扫过 ::selection 这一路（accent 按
 * 30% alpha 合成到 bg 与 bubbleIn 上，全部灰阶 + 饱和 accent × 两个模式），最差约 8.97:1，
 * 安全余量很大——但那是一次性实测，没有测试钉住，而且壁纸这个输入本质上测不了。也就是说
 * 这条复用目前是「量过、成立」，不是「由构造保证」*/
export function themeCssVars(theme: ThemeColors, chatBgOpacity: number): ThemeCssVars {
  const chromeMaterialRgba = alphaColorToRgba({ base: theme.bg2, alpha: CHROME_MATERIAL_ALPHA })

  return {
    '--window-bg-rgb': rgbTriplet(theme.bg),
    '--bg2-rgb': rgbTriplet(theme.bg2),
    '--chat-bg-opacity': String(chatBgOpacity),
    '--bubble-bot-bg': rgbString(theme.bubbleIn),
    '--bubble-user-bg': rgbString(theme.bubbleOut),
    '--bubble-bot-text': rgbString(theme.label.base),
    '--bubble-user-text': rgbString(theme.labelOnAccent),
    '--titlebar-bg': chromeMaterialRgba,
    '--input-bg': chromeMaterialRgba,
    '--titlebar-text': rgbString(theme.label.base),
    '--input-text': rgbString(theme.label.base),
    '--input-placeholder': alphaColorToRgba(theme.label3),
    '--input-border': alphaColorToRgba(theme.separator),
    '--text-secondary': alphaColorToRgba(theme.label2),
    '--system-msg-text': alphaColorToRgba(theme.label2),
    '--scrollbar-thumb': alphaColorToRgba(theme.fill1),
    '--scrollbar-thumb-hover': alphaColorToRgba(boostAlpha(theme.fill1, SCROLLBAR_THUMB_HOVER_ALPHA_BOOST)),
    '--label': rgbString(theme.label.base),
    '--label2': alphaColorToRgba(theme.label2),
    '--label3': alphaColorToRgba(theme.label3),
    '--label4': alphaColorToRgba(theme.label4),
    '--fill1': alphaColorToRgba(theme.fill1),
    '--fill2': alphaColorToRgba(theme.fill2),
    '--fill3': alphaColorToRgba(theme.fill3),
    '--accent': rgbString(theme.bubbleOut),
    '--accent-rgb': rgbTriplet(theme.bubbleOut),
    // --error 是「危险语义的前景色」（红字），--on-error 是压在实心 error 面上的字色。
    // 聊天窗口只用 container 那一对（错误气泡、横幅是有底色的块），设置窗口的危险态文字
    // 和边框用 --error。映射住在这里是因为 themeCssVars 是两个窗口共用的唯一出口
    '--error': rgbString(theme.error),
    '--on-error': rgbString(theme.onError),
    '--error-container': rgbString(theme.errorContainer),
    '--on-error-container': rgbString(theme.onErrorContainer),
  }
}

export interface TitlebarOverlay {
  color: string
  symbolColor: string
}

function toHex([r, g, b]: RgbTuple): string {
  const hex = (n: number) => n.toString(16).padStart(2, '0')
  return `#${hex(r)}${hex(g)}${hex(b)}`
}

/** 经 IPC 'titlebar:set-overlay' 下发给主进程的载荷（electron/main/index.ts 的
 * 'titlebar:set-overlay' 处理器，契约不变：color 恒为 alpha=00、原生按钮条带完全透明，
 * 只有 symbolColor 真正生效，见 TDD §3.7 附「原生按钮条带完全透明」）。
 *
 * 旧模型（chromeColor.ts）用 color2k 的 readableColor() 测量主题色明暗来决定符号色；
 * 新模型没有"测量"这一步——symbolColor 就是这个模式下的 label，跟随模式而不是跟随
 * 某次测量结果，这正是 theme.ts 整体"模式为主轴"设计的自然延伸，不是这里另起的判断规则 */
export function titlebarOverlayFromTheme(theme: ThemeColors): TitlebarOverlay {
  return {
    color: `${toHex(theme.bg)}00`,
    symbolColor: toHex(theme.label.base),
  }
}
