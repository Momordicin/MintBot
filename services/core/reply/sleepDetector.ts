// 回复检查 —— 文本检测类（docs/MintBot_TDD.md §3.8「回复检查」文本检测类，§3.9「困倦不是
// 情绪」）：不拦截，只从正文里识别信号、触发其它行为。当前只有一条规则——从正文识别困意，
// 命中即由调用方（services/core/routes/chat.ts）markExplicitSleep(sessionId)。与拦截类
// 分开成两个文件、两组单测，见 interceptor.ts 顶部注释。

// 检测必须跑在解析后的 reply 正文上，不是原始 JSON——否则会匹配到 JSON 字段值本身
// （调用方负责传入解析后的正文，本模块不做 JSON 解析）

// 第 1 层：剔除非困倦义的词形。裸子串匹配「困」必然被这些词误报
const NON_DROWSY_FORMS = [
  '困难', '困惑', '困扰', '困境', '困局', '贫困', '穷困', '围困', '受困', '困兽', '困顿',
]

// 第 4 层否定排除用到的否定词
const NEGATION_CHARS = ['不', '没', '别', '无']

// 第 4 层正向匹配的模式表：直陈、睡意、体感三个家族
const POSITIVE_PATTERNS = [
  // 直陈
  '困了', '好困', '有点困', '太困了', '困死了', '犯困',
  // 睡意
  '想睡', '想睡觉', '要睡了', '该睡了',
  // 体感
  '眼皮打架', '撑不住了', '打哈欠',
]

// 第 2 层切小句用的标点与换行
const CLAUSE_DELIMITERS = /[。！？，；、\n]/

function stripNonDrowsyForms(text: string): string {
  let result = text
  for (const form of NON_DROWSY_FORMS) {
    result = result.split(form).join('')
  }
  return result
}

function splitClauses(text: string): string[] {
  return text
    .split(CLAUSE_DELIMITERS)
    .map(clause => clause.trim())
    .filter(clause => clause.length > 0)
}

// 第 3 层：小句内出现「你」/「您」（「你们」天然包含「你」，同一次判断即覆盖）即判为在
// 问对方，不触发——角色反过来关心用户困不困是极高频的对话行为
function isSecondPerson(clause: string): boolean {
  return clause.includes('你') || clause.includes('您')
}

// 第 4 层：在小句内查找正向模式表的命中，该命中**之前的任意位置**出现否定词则不算数
// （TDD：「困倦词之前出现 不/没/别/无 等否定词则不触发」）。范围就是这一层的否定判据，
// 不再收紧到「紧邻的前一个字符」：否定词多为多字（「没有」「一点都不」），紧邻判定会漏掉
// 「我没有犯困」这类——命中 `犯困` 的前一个字是「有」，不在否定字符集里，于是被判成真困了。
// 作用范围到小句为止，跨句的否定词由第 2 层的切句挡在外面
function hasUnnegatedMatch(clause: string): boolean {
  for (const pattern of POSITIVE_PATTERNS) {
    let searchFrom = 0
    while (true) {
      const index = clause.indexOf(pattern, searchFrom)
      if (index === -1) break
      const before = clause.slice(0, index)
      if (!NEGATION_CHARS.some(char => before.includes(char))) {
        return true
      }
      searchFrom = index + pattern.length
    }
  }
  return false
}

// 已知残留，规则层面解决不了，记录不修（TDD 原文）：
// - 第三人称引述（「他说他困了」）会误报——规则无法区分"角色自己困"与"角色转述别人困"
// - 语义否定的复杂形式（「困是困，但还能撑」）需要语义理解，规则引擎到此为止
export function detectSleepiness(replyText: string): boolean {
  const stripped = stripNonDrowsyForms(replyText)
  const clauses = splitClauses(stripped)
  for (const clause of clauses) {
    if (isSecondPerson(clause)) continue
    if (hasUnnegatedMatch(clause)) return true
  }
  return false
}
