
const NON_DROWSY_FORMS = [
  '困难', '困惑', '困扰', '困境', '困局', '贫困', '穷困', '围困', '受困', '困兽', '困顿',
]

const NEGATION_CHARS = ['不', '没', '别', '无']

const POSITIVE_PATTERNS = [
  '困了', '好困', '有点困', '太困了', '困死了', '犯困',
  '想睡', '想睡觉', '要睡了', '该睡了',
  '眼皮打架', '撑不住了', '打哈欠',
]

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

function isSecondPerson(clause: string): boolean {
  return clause.includes('你') || clause.includes('您')
}

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

export function detectSleepiness(replyText: string): boolean {
  const stripped = stripNonDrowsyForms(replyText)
  const clauses = splitClauses(stripped)
  for (const clause of clauses) {
    if (isSecondPerson(clause)) continue
    if (hasUnnegatedMatch(clause)) return true
  }
  return false
}
