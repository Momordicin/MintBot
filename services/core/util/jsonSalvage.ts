// 模型 JSON 输出解析的公共兜底逻辑（原先 chat.ts / session/emotion.ts 各自裸调 JSON.parse
// 无兜底、entityExtractor.ts 单独实现了一份贪婪花括号兜底），现集中到这一个无其它 services/core
// 内部依赖的叶子模块，供 routes/、session/、memory/ 三处共同 import，避免互相之间产生循环依赖。
//
// 背景：prompt 要求模型"严格用 JSON 格式回复，不要输出任何其他内容"，但实际观察（尤其是
// Ollama 本地模型、DeepSeek）经常无视这条指令，用 ```json ... ``` 或裸 ``` ... ``` 代码块
// 包裹输出，也可能在 JSON 前后夹带说明性文字（"Sure! Here's the reply: {...}"）。直接
// JSON.parse 在这些情况下会全部失败，不必要地触发调用方本该只在"模型真的没输出合法结构"
// 时才触发的降级路径（chat.ts 回退原始文本 / emotion.ts 返回 null / entityExtractor.ts
// 跳过整个 Layer 3）。
//
// 解析顺序（决定了对"括号嵌套"情况的处理方式）：
//   1. 整段原文直接 JSON.parse——最常见的合规输出，零额外开销
//   2. 代码块内容——```json ... ``` 或裸 ``` ... ```，取围栏内的原文再解析一次。围栏本身
//      就是最准确的对象边界，块内无论嵌套多少层花括号都交给 JSON.parse 处理，不需要额外
//      正则。全文可能出现不止一个围栏块——模型有时会先复述一遍"格式示例"（通常在前）再给出
//      真正回复（通常在后），示例块和真正回复在"形状"上完全一样（都是合法 JSON、都能通过
//      下游按字段做的校验），调用方无法靠校验结果反推"选错了块"。本函数是不带 schema 的
//      通用叶子模块（四个调用方期望的字段形状互不相同），"出现顺序"是唯一可用的信号，因此
//      收集全部围栏块后从最后一个开始尝试解析，命中即返回——这个顺序天然还覆盖了"最后一块
//      本身被截断（未闭合、JSON.parse 失败），只有更早的块才是合法 JSON"的情况：合法的块
//      会在依次回退时被试到并解析成功
//   3. 贪婪花括号匹配（取第一个 { 到最后一个 } 之间的内容）——服务于完全没有代码块围栏、只是
//      前后夹了说明文字的情况（如"Sure! Here's the reply: {...}"），与此前 entityExtractor.ts
//      的实现等价
//
// 贪婪匹配已知的局限（有意保留，不额外处理）：只要真正的 JSON 对象前后混入了任何不属于它
// 自身的字符——无论是一段说明文字里不相关的 {（比如"用户说了句『{ 你好 }』，实际回复是
// {...}"），还是另一个完整的、独立的 JSON 对象（比如同一段文字里先后出现两个 {...}{...}）——
// 拼出来的整个跨度都不再是单一合法 JSON 值的语法（多出的内容要么破坏花括号配对，要么让
// 顶层出现不止一个值），会在 JSON.parse 这一步自然失败并归为"全部失败"，不会把错误的内容
// 悄悄冒充解析成功的结果吐给调用方——两种情况都已由本文件测试用例验证。
// 但这个"整段失败"的保证仅覆盖贪婪匹配自身；如果真正答案完全在围栏之外、且排在一个
// "形状同样合法"的围栏块之后（例如：先来一段带围栏的格式示例，再紧跟一段不带围栏的真正
// 回复），上面第 2 步只会在围栏块内部找"最后一个"，不会去围栏之外找——这种情况下围栏块会
// 解析成功并被当作结果返回，实际上选错了。这是"仅按位置排序、没有 schema"这个设计前提下
// 目前未覆盖的已知局限，不是本次修复的范围（见本文件对应测试用例的说明）。
//
// 三种失败路径都不抛错，统一返回 undefined；是否要把"彻底失败"升级为抛错（如
// entityExtractor.ts 的 parseLayer3Response）还是保持原有的降级返回值（如 emotion.ts 的
// null、chat.ts 回退原文），由各调用方自己决定——本函数不改变任何调用方最终的失败行为，
// 只是多给一次解析机会
const FENCED_BLOCK_PATTERN = /```(?:json)?\s*\n?([\s\S]*?)```/g
const GREEDY_BRACE_PATTERN = /\{[\s\S]*\}/

function tryParse(text: string): unknown {
  try {
    return JSON.parse(text)
  } catch {
    return undefined
  }
}

export function parseJsonSalvage(raw: string): unknown {
  const direct = tryParse(raw)
  if (direct !== undefined) return direct

  // matchAll 需要 g 标志（已加在上面的正则字面量上），按出现顺序收集全部围栏块，
  // 再从最后一个开始试——原因见上方大注释
  const fencedBlocks = [...raw.matchAll(FENCED_BLOCK_PATTERN)].map(m => m[1].trim())
  for (let i = fencedBlocks.length - 1; i >= 0; i--) {
    const parsed = tryParse(fencedBlocks[i])
    if (parsed !== undefined) return parsed
  }

  const braced = raw.match(GREEDY_BRACE_PATTERN)
  if (braced) {
    const parsed = tryParse(braced[0])
    if (parsed !== undefined) return parsed
  }

  return undefined
}
