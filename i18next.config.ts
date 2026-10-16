// i18next.config.ts — i18next-cli 文案提取配置：中文原文为 key，目录输出到 shared/i18n
// 用法：pnpm i18n:extract 提取新文案，pnpm i18n:status 查看英文翻译完成度
// 对应文件：shared/i18n/zh-CN.json / shared/i18n/en.json / shared/i18n/uiI18n.ts
import { defineConfig } from 'i18next-cli'

export default defineConfig({
  locales: ['zh-CN', 'en'],
  extract: {
    input: ['src/**/*.{ts,tsx}', 'electron/**/*.ts'],
    output: 'shared/i18n/{{language}}.json',
    primaryLanguage: 'zh-CN',
    keySeparator: false,
    nsSeparator: false,
  },
})
