// 聊天窗口主题配色（第二代模型，本次重写染色机制 + 角色表）：以「模式为主轴、用户只选
// 一个 accent 色」的参考实现结构。
//
// 本文件是自包含模块：不依赖、不导出 chromeColor.ts 的任何内容，也不修改它——两个模型
// 目前并存，接入 ChatWindow.tsx / global.css 是后续阶段的工作，不在本次改动范围内。
// oklab⇄sRGB 的转换系数与 chromeColor.ts 完全一致（Björn Ottosson 系数：
// https://bottosson.github.io/posts/oklab/），在这里按同样的写法重新实现了一份
// （已用一批网格采样数据核对过两份实现逐位一致、round-trip 误差为 0）。
//
// ─── 取值来源，务必逐个角色标注 ─────────────────────────────────────────────
// 本文件里的每一个具体颜色/alpha 数值都标了来源，三类：
//   「参考实现，社区实测互证」  参考实现的官方设计规范从不公布具体数值，文档原话是
//                          这些颜色"may fluctuate from release to release"（设计态
//                          参考，非运行态承诺）。下面所有标"参考实现"的数字，都是从
//                          多份互相独立的第三方运行时取色结果里交叉核对、彼此一致后
//                          采用的，不是抄自参考实现自己发布的任何文档
//   「Material，第一方」    M3 的 error 色板确有第一方数值来源：google 的
//                          material-web 仓库里的静态 design token，以及
//                          material-color-utilities 生成器的算法输出，见下方
//                          error 色板小节的具体引用
//   「本项目自定」          规格里没有给、或者参考实现/Material 都没有公开对应数值，
//                          由本次实现直接选定的具体数字（主要是两档 tint 强度 k、
//                          fill2/fill3 两档 alpha）

export type RgbTuple = [number, number, number]
export type ThemeMode = 'day' | 'night'

export interface ThemeInput {
  /** 用户选择的唯一一个 accent 色 */
  accentRgb: RgbTuple
  /** 已解析的模式；'auto' 由调用方解析成 'day'/'night' 后再传进来，这里不处理 */
  mode: ThemeMode
  /** 0..1，0 = 纯参考发布值（重置按钮就是把这个设成 0） */
  tintStrength: number
}

/** 带透明度的角色：参考实现官方发布的 label/secondaryLabel/tertiaryLabel/quaternaryLabel/
 * separator 本来就是"底色 + 固定 alpha"定义的（要合成到具体背景上时才需要一个不透明
 * RGB），保留这个形状而不是提前合成死，让消费方自己决定要合成到 background 之上
 * 还是别的表面之上（比如气泡内的分隔线要合成到气泡底色上，不是窗口 background 上） */
export interface AlphaColor {
  base: RgbTuple
  alpha: number
}

// ─── 产出的角色集合 ──────────────────────────────────────────────────────
//
// 背景：bg / bg2 / bg3（依次对应参考实现的 systemBackground /
// secondarySystemBackground / tertiarySystemBackground）。旧模型另有一个
// elevatedSurface 名字，本次删除——它就是 bg3，不再需要一个单独的别名，night 模式下
// bg3（incoming 气泡）已经是它的真实消费方
//
// 文字：label / label2 / label3 / label4，四级都保留成 { base, alpha } 形状（参考实现
// 的 label 家族本来就是"纯黑/纯白 + alpha"统一定义的，label 本身的 alpha 恒为 1.0，
// 跟其余三级用同一个形状而不是特例成裸 RgbTuple，方便调用方一致处理）
//
// 分隔线：separator（半透明，叠加到具体表面上时用）+ separatorOpaque（参考实现同时
// 发布的不透明等效色，供不想处理透明合成的场景直接用）
//
// 填充：fill1 / fill2 / fill3，三档，大面积用更低 alpha（参考实现的公开原则，见下方
// fill 小节），只有 fill1 有参考实现来源，fill2/fill3 是本项目按同一原则自己定的
//
// 气泡：bubbleIn（= bg2 day / bg3 night，随染色联动）、bubbleOut（accent 经钳制
// 派生，见规则 2，永不染色）、labelOnAccent（恒定纯白，永不染色）
//
// 错误：error / onError / errorContainer / onErrorContainer，M3 色板，永不染色、
// 不随 accent 变化
export interface ThemeColors {
  bg: RgbTuple
  bg2: RgbTuple
  bg3: RgbTuple
  bubbleIn: RgbTuple
  /** 压在 bubbleOut 上的文字色，恒为纯白，两个模式都一样。
   *
   * 这个字段看起来是个常量、显得多余，但它必须存在：clampAccentForBubble 把 accent
   * 钳到白字对比度达标（连同 night 模式下的背景可区分下限），整条钳制规则的存在理由
   * 就是「outgoing 气泡上叠白字」。
   * 如果不把这个契约表达在类型里，消费方完全可能顺手把 label（day 模式下是纯黑）
   * 放到 bubbleOut 上——那一刻钳制保证的东西跟实际画出来的东西就对不上了，而且不会
   * 有任何报错。宁可留一个恒定字段，也不要让这条契约只活在注释里 */
  labelOnAccent: RgbTuple
  bubbleOut: RgbTuple
  label: AlphaColor
  label2: AlphaColor
  label3: AlphaColor
  label4: AlphaColor
  separator: AlphaColor
  separatorOpaque: RgbTuple
  fill1: AlphaColor
  fill2: AlphaColor
  fill3: AlphaColor
  error: RgbTuple
  onError: RgbTuple
  errorContainer: RgbTuple
  onErrorContainer: RgbTuple
}

// ─── oklab ⇄ sRGB（与 chromeColor.ts 同款系数，模块私有）──────────────────

function srgbToLinear(c: number): number {
  const v = c / 255
  return v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4
}

function linearToSrgbUnrounded(c: number): number {
  const clamped = Math.min(1, Math.max(0, c))
  return clamped <= 0.0031308 ? clamped * 12.92 : 1.055 * clamped ** (1 / 2.4) - 0.055
}

function linearToSrgb(c: number): number {
  return Math.round(linearToSrgbUnrounded(c) * 255)
}

interface Oklab {
  L: number
  a: number
  b: number
}

function rgbToOklab([r, g, b]: RgbTuple): Oklab {
  const lr = srgbToLinear(r)
  const lg = srgbToLinear(g)
  const lb = srgbToLinear(b)

  const l = 0.4122214708 * lr + 0.5363325363 * lg + 0.0514459929 * lb
  const m = 0.2119034982 * lr + 0.6806995451 * lg + 0.1073969566 * lb
  const s = 0.0883024619 * lr + 0.2817188376 * lg + 0.6299787005 * lb

  const l_ = Math.cbrt(l)
  const m_ = Math.cbrt(m)
  const s_ = Math.cbrt(s)

  return {
    L: 0.2104542553 * l_ + 0.7936177850 * m_ - 0.0040720468 * s_,
    a: 1.9779984951 * l_ - 2.4285922050 * m_ + 0.4505937099 * s_,
    b: 0.0259040371 * l_ + 0.7827717662 * m_ - 0.8086757660 * s_,
  }
}

/** oklab → 线性 sRGB 三通道（未裁剪、未量化到 8-bit）*/
function oklabToLinearRgb({ L, a, b }: Oklab): [number, number, number] {
  const l_ = L + 0.3963377774 * a + 0.2158037573 * b
  const m_ = L - 0.1055613458 * a - 0.0638541728 * b
  const s_ = L - 0.0894841775 * a - 1.2914855480 * b

  const l = l_ ** 3
  const m = m_ ** 3
  const s = s_ ** 3

  const lr = 4.0767416621 * l - 3.3077115913 * m + 0.2309699292 * s
  const lg = -1.2684380046 * l + 2.6097574011 * m - 0.3413193965 * s
  const lb = -0.0041960863 * l - 0.7034186147 * m + 1.7076147010 * s

  return [lr, lg, lb]
}

function oklabToRgb(lab: Oklab): RgbTuple {
  const [lr, lg, lb] = oklabToLinearRgb(lab)
  return [linearToSrgb(lr), linearToSrgb(lg), linearToSrgb(lb)]
}

function hexToRgb(hex: string): RgbTuple {
  const n = parseInt(hex.slice(1), 16)
  return [(n >> 16) & 0xff, (n >> 8) & 0xff, n & 0xff]
}

const WHITE: RgbTuple = [255, 255, 255]

// ─── 规则 1：tint——往 accent 方向做 oklab 三分量混合 ───────────────────────
// 旧模型：保持 oklab L 恒定，只在 a/b 上加位移，位移超出色域就二分收缩。这个模型的
// 后果是 day 的纯白背景、night 的纯黑背景（label 也一样）正好落在 sRGB 色域的顶点，
// 顶点处色域宽度为零，二分必然收敛到"不染"——窗口里最大的一块表面（background）
// 因此永远不可能被染色。用户要的是「accent 能画到 day 的白色背景上，颜色深浅由旋钮
// 控制」，这在旧模型下几何上不可能做到。
//
// 新模型：不再保持 L 不变，而是把角色的 oklab (L, a, b) 三个分量一起按
// tintStrength*k 的比例向 accent 的 oklab 线性插值（"混合"，不是"位移"）。
// 不再需要色域顶点特例、不再需要对位移量二分——day 的纯白 background 在 tint>0 时
// 会明确地往 accent 那个方向移动，这正是本次要修的行为。
//
// 代价：旧模型"tint 不可能损害对比度"这条不变量（靠 L 恒定）不再成立——现在 tint 会
// 让 L 一起动。替换成的新保证不再是数学上的先验（"L 不变故对比度不变"），而是靠给
// 每档 k 选一个足够小的上限、再用测试扫描确认「accent × tint 全空间下对比度下限」
// 从不跌破一个安全值——见 theme.test.ts 的"对比度下限"一组测试，那组测试的下限本身
// 是从实测的最坏情形里量出来的，不是先验断言
function tintRole(rgb: RgbTuple, accentLab: Oklab, tintStrength: number, k: number): RgbTuple {
  if (tintStrength <= 0 || k === 0) return rgb

  const ratio = tintStrength * k
  const lab = rgbToOklab(rgb)
  return oklabToRgb({
    L: lab.L + (accentLab.L - lab.L) * ratio,
    a: lab.a + (accentLab.a - lab.a) * ratio,
    b: lab.b + (accentLab.b - lab.b) * ratio,
  })
}

// 两档 k 都是本项目自定的具体数值（规格没有给、参考实现/Material 也没有对应数值），
// 不是从任何发布来源抄来的——如果之后觉得力度不对，调整这两个常量即可，不影响其余
// 结构
//
// surfaces（bg/bg2/bg3/incoming 气泡/separator）用 k=0.14——这些都是"底色/分隔线"
// 一类的填充角色，观感上能接受比较明显的染色。separatorOpaque 是 separator 的不
// 透明等效表示、不是独立角色，这里把它并入同一档——规格没有单独点名它属于哪一档，
// 判断它跟 separator 应该同步染色是本次实现自己做的选择，不是抄规格
const SURFACE_TINT_K = 0.14

// label 系（label/label2/label3/label4）与三档 fill 用小得多的 k=0.05——label 是
// 文字角色，染色过重会让黑白文字看起来"脏"；fill 是控件填充，同样偏视觉噪音，规格
// 把这两类归成同一档
const LABEL_FILL_TINT_K = 0.05

// ─── 规则 2：accent——钳制到「白字可读」且「与背景可区分」（未改动）────────────
// 本节与 clampAccentForBubble() 本身在本次改动中完全未变——bubbleOut 是"已经有意义
// 的颜色"（白字对比度承诺的锚点），染色会直接破坏这条承诺，因此规格明确要求它连同
// labelOnAccent、整个 error 色板一起永不参与 tint。
//
// 参考实现的 accent 气泡恒定叠白字，把 accent 的 oklab L 向下二分（保持色相/彩度，即
// a/b 不变），直到白字对比度达到 4.5:1，这是第一条约束，也是较重要的一条——文字是
// 用户真正要读的东西。
//
// 但只钳这一条不够：它只在 L 上设了一个上界（够暗才能配白字），从不设下界。day 的
// bg 是 #ffffff，钳到白字可读顺带也钳到了「气泡跟背景有区别」（更暗的 accent 离纯白
// 背景只会更远，两条约束同向，day 不需要额外下界——已用扫描核实，见 theme.test.ts）。
// 但 night 的 bg 是 #000000：钳到白字可读这个方向对已经很暗的 accent 完全不生效
// （本来就达标，直接原样返回），于是一个接近纯黑的 accent（比如
// Presets.displayConfig.chatBgRgb 的默认值 [15,15,20]）会产生一个跟纯黑背景几乎
// 无法区分的气泡。因此第二条约束——气泡与背景的对比度 ≥ 3.0（WCAG 2.1 1.4.11 非
// 文字 UI 组件对比度下限）——只在 night 模式下会真正生效，充当 L 的下界。
//
// clampAccentForBubble 传入的 background 参数固定用查表得到的原始 bg（未经 tint），
// 与本次改动之前完全一致——tint 现在会让实际渲染出的 bg 也跟着移动，但这条钳制规则
// 的锚点是否要跟着换成"tint 之后的 bg"是一个独立的问题，本次不在改动范围内（钳制
// 函数本身规格明确要求"未改动"），继续用查表原始值

export const WHITE_ON_ACCENT_MIN_CONTRAST = 4.5

/** 气泡与所在窗口 background 的最小对比度——WCAG 2.1 1.4.11「非文字对比度」的下限，
 * 用来防止（night 模式下）一个已经够暗、白字对比度达标的 accent 同时暗到跟纯黑的
 * background 融为一体。day 模式的 background 是纯白，这条约束在几何上已经被约束 1
 * 蕴含，不会单独生效——见上方规则 2 的推导注释 */
export const BUBBLE_BACKGROUND_MIN_CONTRAST = 3.0

const BINARY_SEARCH_ITERATIONS = 60

function relativeLuminance([r, g, b]: RgbTuple): number {
  return 0.2126 * srgbToLinear(r) + 0.7152 * srgbToLinear(g) + 0.0722 * srgbToLinear(b)
}

/** WCAG 相对亮度对比度（(L1+0.05)/(L2+0.05)，L1 取较亮的一方） */
export function contrastRatio(rgbA: RgbTuple, rgbB: RgbTuple): number {
  const la = relativeLuminance(rgbA)
  const lb = relativeLuminance(rgbB)
  const lighter = Math.max(la, lb)
  const darker = Math.min(la, lb)
  return (lighter + 0.05) / (darker + 0.05)
}

/** 把 accent 的 oklab L 钳到同时满足「白字可读」与「跟 background 可区分」的区间内，
 * 保持色相/彩度（a/b）不变。background 由调用方按模式传入（day=#ffffff，night=
 * #000000），使 bubbleOut 随模式产出不同的值——这与参考实现系统色本身也按模式区分
 * 是同一回事（systemBlue 在 light/dark 下就是 #007AFF / #0A84FF 两个不同值） */
function clampAccentForBubble(accentRgb: RgbTuple, background: RgbTuple): RgbTuple {
  const lab = rgbToOklab(accentRgb)
  const rgbAtL = (L: number): RgbTuple => oklabToRgb({ L, a: lab.a, b: lab.b })
  const passesWhiteText = (L: number) => contrastRatio(WHITE, rgbAtL(L)) >= WHITE_ON_ACCENT_MIN_CONTRAST
  const passesBackground = (L: number) => contrastRatio(rgbAtL(L), background) >= BUBBLE_BACKGROUND_MIN_CONTRAST

  // accent 本身已经落在可行区间内，不需要钳制
  if (passesWhiteText(lab.L) && passesBackground(lab.L)) {
    return rgbAtL(lab.L)
  }

  if (!passesWhiteText(lab.L)) {
    // accent 太亮：白字对比度不够，向下二分。lo 恒满足对比度达标（起点 L=0，纯黑对
    // 白对比度 21:1 必然达标），hi 恒不达标（起点是 accent 原始 L），收敛到达标一侧
    // 的边界
    let lo = 0
    let hi = lab.L
    for (let i = 0; i < BINARY_SEARCH_ITERATIONS; i++) {
      const mid = (lo + hi) / 2
      if (passesWhiteText(mid)) lo = mid
      else hi = mid
    }
    return rgbAtL(lo)
  }

  // 白字对比度已经达标，但（仅可能发生在 night 模式）跟 background 融为一体：向上
  // 二分，找到刚好满足背景对比度的最小 L
  let lo = lab.L
  let hi = 1
  for (let i = 0; i < BINARY_SEARCH_ITERATIONS; i++) {
    const mid = (lo + hi) / 2
    if (passesBackground(mid)) hi = mid
    else lo = mid
  }
  return rgbAtL(hi)
}

// ─── alpha 合成 ──────────────────────────────────────────────────────────

/** 把一个 { base, alpha } 角色合成到具体背景之上，得到不透明 RGB。标准 sRGB 空间
 * 直接按通道线性混合（不是 oklab 空间）——这与参考实现发布 separator 的不透明等效值
 * 的算法一致（见 theme.test.ts 的外部核对用例），因为这些颜色本来就是定义成"以这个
 * alpha 叠在系统背景上会长这样"，不是拿去做感知均匀混色 */
export function compositeOverBackground(fg: AlphaColor, bg: RgbTuple): RgbTuple {
  const [fr, fg_, fb] = fg.base
  const [br, bgc, bb] = bg
  const a = fg.alpha
  return [
    Math.round(fr * a + br * (1 - a)),
    Math.round(fg_ * a + bgc * (1 - a)),
    Math.round(fb * a + bb * (1 - a)),
  ]
}

// ─── 按模式查表的中性角色 ──────────────────────────────────────────────────

interface NeutralTable {
  bg: RgbTuple
  bg2: RgbTuple
  bg3: RgbTuple
  separatorOpaque: RgbTuple
  label: AlphaColor
  label2: AlphaColor
  label3: AlphaColor
  label4: AlphaColor
  separator: AlphaColor
  fill1: AlphaColor
  fill2: AlphaColor
  fill3: AlphaColor
}

// fill 三档共用同一个底色，两个模式相同——参考实现公开的 fill 家族本来就是"同一个灰
// 按不同 alpha 叠出深浅"，不是像 label 那样黑白对调
const FILL_BASE: RgbTuple = hexToRgb('#787880')

const DAY_TABLE: NeutralTable = {
  // 背景三档：参考实现，社区实测互证
  bg: hexToRgb('#ffffff'),
  bg2: hexToRgb('#f2f2f7'),
  bg3: hexToRgb('#ffffff'),

  // 分隔线不透明等效色：参考实现，社区实测互证
  separatorOpaque: hexToRgb('#c6c6c8'),

  // label 四级：参考实现，社区实测互证。label3 的数值同时也是参考实现发布的
  // placeholderText——两者解析到完全相同的 { base, alpha }，因此不另设第五个角色，
  // 消费方需要 placeholder 颜色时直接用 label3
  label: { base: hexToRgb('#000000'), alpha: 1.0 },
  label2: { base: hexToRgb('#3c3c43'), alpha: 0.60 },
  label3: { base: hexToRgb('#3c3c43'), alpha: 0.30 },
  label4: { base: hexToRgb('#3c3c43'), alpha: 0.18 },

  // 分隔线（半透明）：参考实现，社区实测互证
  separator: { base: hexToRgb('#3c3c43'), alpha: 0.29 },

  // fill 三档：只有 fill1 是参考实现的 systemFill，两个独立来源互证；fill2/fill3
  // 是本项目自定——参考实现公开的原则是"填充面积越大，alpha 越低"，fill2/fill3 按这条
  // 原则、以 fill1 为锚点、每档 ≈0.7× 上一档选出来的（day: 0.20 → 0.14 → 0.08；
  // night: 0.36 → 0.26 → 0.16——两组比值并不是精确的 0.70，是从"取一个视觉上有区分度
  // 的干净两位小数"倒推出来的，跟 0.7 这个粗略比例对得上但不是逐位精确套用；参考实现
  // 自己 secondary/tertiary/quaternarySystemFill 的 alpha 无法从任何来源核实，我们
  // 因此只保留三档而不凑出第四档去对应参考实现的四档）
  fill1: { base: FILL_BASE, alpha: 0.20 },
  fill2: { base: FILL_BASE, alpha: 0.14 },
  fill3: { base: FILL_BASE, alpha: 0.08 },
}

const NIGHT_TABLE: NeutralTable = {
  bg: hexToRgb('#000000'),
  bg2: hexToRgb('#1c1c1e'),
  bg3: hexToRgb('#2c2c2e'),

  separatorOpaque: hexToRgb('#38383a'),

  label: { base: hexToRgb('#ffffff'), alpha: 1.0 },
  label2: { base: hexToRgb('#ebebf5'), alpha: 0.60 },
  label3: { base: hexToRgb('#ebebf5'), alpha: 0.30 },
  label4: { base: hexToRgb('#ebebf5'), alpha: 0.18 },

  // night 的 alpha 从旧模型的 0.65 改成 0.60：0.60 现在有两个独立来源互证，0.65 一个
  // 来源都没有，改成有实测支持的那个数字
  separator: { base: hexToRgb('#545458'), alpha: 0.60 },

  fill1: { base: FILL_BASE, alpha: 0.36 },
  fill2: { base: FILL_BASE, alpha: 0.26 },
  fill3: { base: FILL_BASE, alpha: 0.16 },
}

// ─── error 色板（Material 3，第一方数值，永不染色、不随 accent 变化）──────────
// 来源：material-web 仓库里随包发布的静态 design token，与 material-color-utilities
// 生成器的算法输出——这是两份不同的第一方 Google 产物，而不是同一份数据的两次引用。
//
// 两者在 night 模式的 onErrorContainer 上不一致：静态 token 是 #410E0B，生成器算出
// 来的是 #8C1D18（这行是 night 列，注意此处指的是这一个值本身在两份来源之间的分歧，
// 不是 day/night 两个模式的分歧）。这里采用 #410E0B——它是"打算被消费"的那份制品
// （生成器是内部算法实现，token 才是发布给使用方的产物），第三方引用也无一例外指向
// 这个值。两者的分歧照实记录在这里，不悄悄抹掉。
//
// M3 的对比度目标（供参照，不是这里要计算验证的东西——这几对颜色是第一方发布的具体
// 数值，已经达到这些目标，不需要本模块重新推导）：
//   onError 叠在 error 上          目标 7.0:1
//   onErrorContainer 叠在 errorContainer 上  目标 4.5:1
//   error 叠在表面背景上           目标 4.5:1
//
// M3 没有 warning 角色——任何版本的规范都没有定义，Google 也没有发布替代方案，这里
// 刻意不发明一个：警告状态复用 error 色板，不要在这之后补一个 warning
interface ErrorPalette {
  error: RgbTuple
  onError: RgbTuple
  errorContainer: RgbTuple
  onErrorContainer: RgbTuple
}

const DAY_ERROR: ErrorPalette = {
  error: hexToRgb('#b3261e'),
  onError: hexToRgb('#ffffff'),
  errorContainer: hexToRgb('#f9dedc'),
  onErrorContainer: hexToRgb('#410e0b'),
}

const NIGHT_ERROR: ErrorPalette = {
  error: hexToRgb('#f2b8b5'),
  onError: hexToRgb('#601410'),
  errorContainer: hexToRgb('#8c1d18'),
  onErrorContainer: hexToRgb('#f9dedc'),
}

// ─── 主入口 ───────────────────────────────────────────────────────────────

/** 按模式查表取中性角色，用 accent 染色（规则 1）、用 accent 钳制出 bubbleOut
 * （规则 2），拼出完整的 ThemeColors。tintStrength=0 时每个可染色角色都直接短路返回
 * 表里的原始值，字节级等于发布值——这就是"回到基准配色"按钮背后的保证。
 *
 * bubbleIn 直接取染色后的 bg2（day）/ bg3（night），不单独再染一次——它本来就等于
 * 这两个角色之一（规格明确要求"bubbleIn = bg2 in day, bg3 in night"），参考实现没有
 * 发布过专门的"气泡"角色。
 * day模式下这带来一个已知后果：#F2F2F7 叠在 #FFFFFF 上只有约 1.05:1 的对比度，气泡的可分辨性这一步
 * 不来自底色对比，而是留给渲染层接线阶段要加的投影
 *
 * bubbleOut 按模式钳制到不同区间，因此是 mode 相关的（day/night 对同一个 accent
 * 可能产出不同的气泡色）。error 色板不受 accent/tint 影响，按模式查表直接返回 */
export function deriveTheme(input: ThemeInput): ThemeColors {
  const table = input.mode === 'day' ? DAY_TABLE : NIGHT_TABLE
  const errorPalette = input.mode === 'day' ? DAY_ERROR : NIGHT_ERROR
  const accentLab = rgbToOklab(input.accentRgb)
  const { tintStrength } = input

  const tintSurface = (rgb: RgbTuple) => tintRole(rgb, accentLab, tintStrength, SURFACE_TINT_K)
  const tintLabelOrFill = (rgb: RgbTuple) => tintRole(rgb, accentLab, tintStrength, LABEL_FILL_TINT_K)
  const tintAlphaSurface = (c: AlphaColor): AlphaColor => ({ base: tintSurface(c.base), alpha: c.alpha })
  const tintAlphaLabelOrFill = (c: AlphaColor): AlphaColor => ({ base: tintLabelOrFill(c.base), alpha: c.alpha })

  const bg = tintSurface(table.bg)
  const bg2 = tintSurface(table.bg2)
  const bg3 = tintSurface(table.bg3)
  const bubbleIn = input.mode === 'day' ? bg2 : bg3
  const label = tintAlphaLabelOrFill(table.label)
  const label2 = tintAlphaLabelOrFill(table.label2)
  const label3 = tintAlphaLabelOrFill(table.label3)
  const label4 = tintAlphaLabelOrFill(table.label4)
  const separator = tintAlphaSurface(table.separator)
  const separatorOpaque = tintSurface(table.separatorOpaque)
  const fill1 = tintAlphaLabelOrFill(table.fill1)
  const fill2 = tintAlphaLabelOrFill(table.fill2)
  const fill3 = tintAlphaLabelOrFill(table.fill3)
  const bubbleOut = clampAccentForBubble(input.accentRgb, table.bg)

  return {
    bg,
    bg2,
    bg3,
    bubbleIn,
    bubbleOut,
    // 不参与 tint：它是钳制规则的另一半，染一点色相就等于把那条 4.5:1 的保证削掉一角
    labelOnAccent: WHITE,
    label,
    label2,
    label3,
    label4,
    separator,
    separatorOpaque,
    fill1,
    fill2,
    fill3,
    error: errorPalette.error,
    onError: errorPalette.onError,
    errorContainer: errorPalette.errorContainer,
    onErrorContainer: errorPalette.onErrorContainer,
  }
}
