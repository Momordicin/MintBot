// services/core/roleConfig/prompts.ts — 一键生成角色配置用到的四段提示词：A 从人设抽名字、B 交给订阅的联网搜索、C 统合搜索结果、D 找错写
// 用法：roleConfig/lookup.ts 调 buildExtractPrompt / buildSearchPrompt / buildMergePrompt；roleConfig/collect.ts 调 buildMisspellingPrompt；work 为空时对应位置留空
// 对应文件：services/core/roleConfig/lookup.ts / services/core/roleConfig/collect.ts / services/core/search/webSearch.ts
import type { WebSearchResult } from '../search/webSearch.js'

export function buildExtractPrompt(persona: string, displayName: string): string {
  return `下面是一个角色的人设：
<persona>
${persona}
</persona>
角色在 MintBot 里的显示名：${displayName}

这次要取的是这个角色的名字和别称，用来联网搜索这个角色。请从人设中找出：
- main_name：角色本身的名字；人设没写名字时用显示名
- work：角色出自的作品名；人设没写出处时填空字符串
- aliases：人设里提到的这个角色的别称、外号、网名、称号，不含对用户的称呼
规则：只取人设里真实出现过的词，不要补充人设里没有的内容。
只输出 JSON 对象，不要其他内容：
{"main_name": "...", "work": "...", "aliases": ["..."]}`
}

export function buildSearchPrompt(mainName: string, work: string): string {
  return `请联网搜索下面这个角色，这次要取的是这个角色的别名和各种称呼。找出介绍这个角色别名和各种称呼的网页：别名、外号、昵称、网名、称号，以及外文名（如英文名、日文名、韩文名）。只根据搜到的网页回答，不要凭自己的知识补充。按网页逐条列出：网页标题、网页链接、这个网页里提到这些别名和称呼的原文摘录。
角色主名：${mainName}
作品出处：${work}`
}

export function buildMergePrompt(search: WebSearchResult, mainName: string, work: string, aliases: string[]): string {
  const head = search.results.length > 0
    ? `下面是联网搜索得到的网页，每个网页有编号：
${search.results.map((item, i) => `[${i + 1}] 标题：${item.title} 链接：${item.url} 摘录：${item.snippet}`).join('\n')}`
    : `下面是联网搜索得到的回答，回答里按网页逐条列出了标题、链接和原文摘录。请按回答中网页出现的顺序，依次给每个网页编号 1、2、3……：
${search.answer ?? ''}`
  return `${head}

要找的角色：
角色主名：${mainName}
作品出处：${work}
人设里提到的别称：${aliases.join('、')}

这次要取的是这个角色的别名和各种称呼。请按下面的步骤整理：
1. 先判断每个网页讲的是哪一个角色。不同网页讲的是同一个角色的，归为一组；名字相同但出自不同作品的，或者明显是不同人物的，分成不同的组；和要找的角色无关的网页，不放进任何一组。
2. 每一组整理成一个备选项，包含：
   - main_name：这个角色的主名
   - aliases：这一组网页原文里出现过的这个角色的别名和各种称呼（别名、外号、昵称、网名、称号、外文名），每一个附上出现它的网页编号
   - source_summary：这个角色的出处简介，一两句话
   - relation：网页里提到的这个角色与主角或用户（玩家）的关系；没有提到就填 null
   - pages：这一组包含的网页编号
3. 只根据上面网页的原文整理，不要用你自己已知的内容补充。
4. 没有任何一组和要找的角色有关时，candidates 为空数组。

只输出 JSON 对象，不要其他内容；没有任何一组和要找的角色有关时，candidates 为空数组：
{"candidates": [{"main_name": "...", "aliases": [{"name": "...", "pages": [1, 3]}], "source_summary": "...", "relation": "..." 或 null, "pages": [1, 3]}]}`
}

export interface MisspellingGroup {
  name: string
  samples: { script: string; transcript: string }[]
}

export function buildMisspellingPrompt(groups: MisspellingGroup[]): string {
  const body = groups
    .map(group => `称呼：${group.name}
${group.samples.map((sample, i) => `[${i + 1}] 朗读稿：${sample.script} 转写：${sample.transcript}`).join('\n')}`)
    .join('\n')
  return `下面是一组朗读稿和语音识别的转写。朗读稿里的称呼是正确写法；转写里同一位置的文字可能被识别成了别的字或词。
${body}

这次要取的是每个称呼被识别错的写法。请对每一句找出转写里对应称呼位置的文字，和称呼写法不同（不区分大小写）就记为一个错写。只根据转写原文，不要自己猜测可能的错写。
只输出 JSON 对象，不要其他内容；没有错写时 misspellings 为空数组：
{"names": [{"name": "...", "misspellings": ["..."]}]}`
}
