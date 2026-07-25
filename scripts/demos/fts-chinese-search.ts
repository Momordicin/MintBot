// 手动验证 FTS5 + simple 分词器（libsimple 扩展）中文分词/子串检索效果用的小工具，
// 不是自动化测试；自动化测试见 services/core/session/queries.test.ts 里的
// 'FTS (message_fts)' 和 'backfillMessageFts (v5 迁移回填逻辑)' 两个 describe 块。
//
// 用一个内存态（:memory:）的临时 better-sqlite3 实例，不碰真实的 data/db.sqlite。
// 运行方式：pnpm demo:fts（tsx 直接跑源码）。
//
// DIV-002 背景：message_fts 的分词器从 unicode61 换成 simple 后，中文按逐字符子串索引，
// 可以命中任意跨"词"边界的子串；英文仍按连续字母整词索引。拼音检索（官方文档提到的功能）
// 实测未生效，本脚本不演示这一项。

import Database from 'better-sqlite3'
import path from 'path'
import readline from 'readline'

const SIMPLE_DLL_PATH = path.resolve(
  process.cwd(),
  'services/core/db/vendor/libsimple-windows-x64/simple.dll'
)

interface DemoSentence {
  id: number
  content: string
}

// 内置示例句子，覆盖已验证过的典型场景：2 字词、单字、专有名词/人名、跨词边界子串
const DEMO_SENTENCES: DemoSentence[] = [
  { id: 1, content: '我喜欢猫和狗' },
  { id: 2, content: '我最近在玩原神' },
  { id: 3, content: '张三昨天来找我了' },
  { id: 4, content: '今天天气很好' },
  { id: 5, content: 'I use ChatGPT every day' },
]

// 内置几个查询示例，方便不想自己输入的人直接看到效果
const DEMO_QUERIES = [
  '喜欢', // 2 字词
  '猫', // 单字
  '原神', // 专有名词
  '张三', // 人名
  '欢猫', // 跨"喜欢"/"猫"两个词边界的子串，不是真实存在的词
  'ChatGPT', // 英文整词
  'chat', // 英文子串（预期不命中，英文仍按整词索引）
]

function createDemoDb(): Database.Database {
  const db = new Database(':memory:')
  db.loadExtension(SIMPLE_DLL_PATH)
  db.exec(`
    CREATE VIRTUAL TABLE message_fts USING fts5(
      content,
      message_id UNINDEXED,
      tokenize = 'simple'
    );
  `)
  const insert = db.prepare(`INSERT INTO message_fts (content, message_id) VALUES (?, ?)`)
  for (const s of DEMO_SENTENCES) {
    insert.run(s.content, s.id)
  }
  return db
}

function search(db: Database.Database, query: string): void {
  const rows = db.prepare(`
    SELECT message_id, content, rank FROM message_fts
    WHERE content MATCH ? ORDER BY rank
  `).all(query) as { message_id: number; content: string; rank: number }[]

  console.log(`\n查询 "${query}":`)
  if (rows.length === 0) {
    console.log('  (无命中)')
  } else {
    for (const row of rows) {
      console.log(`  [id=${row.message_id}] ${row.content}`)
    }
  }
}

async function main() {
  console.log('内置示例句子：')
  for (const s of DEMO_SENTENCES) {
    console.log(`  [id=${s.id}] ${s.content}`)
  }

  const db = createDemoDb()

  console.log('\n=== 内置查询示例（覆盖已验证过的典型场景）===')
  for (const q of DEMO_QUERIES) {
    search(db, q)
  }

  console.log('\n=== 手动输入查询词（回车跳过，输入空行 / 直接 Ctrl+C 退出）===')
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout })
  const ask = (question: string): Promise<string> =>
    new Promise(resolve => rl.question(question, resolve))

  // eslint-disable-next-line no-constant-condition
  while (true) {
    const query = await ask('查询词> ')
    if (!query) break
    search(db, query)
  }

  rl.close()
  db.close()
}

main().catch(err => {
  console.error('[demo:fts] failed:', err)
  process.exit(1)
})
