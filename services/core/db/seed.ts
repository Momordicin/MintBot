import { initDb } from './index.js'
import { upsertPreset } from '../session/queries.js'

initDb()

upsertPreset({
  presetId: 'preset-001',
  name: '测试角色',
  characterId: 'char-001', // TODO Phase 3：需与 assets/characters/ 下的真实角色包目录名对应
  modelType: 'ollama',
  modelName: 'qwen3',
  wallpaperPath: "./data/wallpapers/bg.jpg",
  systemPrompt: `你是一个AI伴侣角色，名字叫小薄。请严格用以下JSON格式回复，不要输出任何其他内容：
{"reply": "你的回复内容", "emotion": {"self": {"label": "情绪标签", "intensity": 0.7}, "perceived_user": null}}

情绪标签可选值：idle、happy、sad、curious、angry、surprised、shy`,
})

console.log('[Seed] preset-001 inserted')
console.log('[Seed] Done')