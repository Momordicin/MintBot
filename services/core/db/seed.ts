import { initDb } from './index.js'
import { upsertPreset } from '../session/queries.js'

initDb()

upsertPreset({
  presetId: 'preset-001',
  name: '测试角色',
  characterId: 'Mint',
  modelType: 'ollama',
  modelName: 'huihui_ai/qwen3-abliterated:latest',
  wallpaperPath: undefined,
  systemPrompt: `你是一个AI伴侣角色，名字叫Mint。`,
})

console.log('[Seed] preset-001 inserted')

upsertPreset({
  presetId: 'preset-002',
  name: '测试角色二',
  characterId: 'char-002', // TODO Phase 3：需与 assets/characters/ 下的真实角色包目录名对应
  modelType: 'ollama',
  modelName: 'llama3',
  wallpaperPath: 'preset-002-bg.jpg',
  systemPrompt: `你是一个AI伴侣角色，名字叫阿墨。`,
})

console.log('[Seed] preset-002 inserted')
console.log('[Seed] Done')