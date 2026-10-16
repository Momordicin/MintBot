// services/core/routes/ui.ts — 界面语言设置的读取与修改路由
// 用法：core/index.ts 注册 uiRoutes；GET、PATCH /config/ui，PATCH 体为 { language }；SSE 事件 ui-language-changed
// 对应文件：shared/uiLocale.ts / services/core/config/index.ts / src/settings/GeneralPanel.tsx / src/i18n.ts / electron/main/index.ts / shared/errorCodes.ts
import type { FastifyInstance } from 'fastify'
import { ConfigFileUnreadableError } from '../config/configFileError.js'
import { getUiLanguage, updateUiLanguage } from '../config/index.js'
import { broadcastEvent } from '../events/broadcast.js'
import { VALID_UI_LANGUAGES } from '../../../shared/uiLocale.js'
import type { UiLanguage } from '../../../shared/uiLocale.js'
import { ERROR_CODES, errorBody, invalidRequest } from '../../../shared/errorCodes.js'

export async function uiRoutes(fastify: FastifyInstance) {
  fastify.get('/config/ui', async () => ({ language: getUiLanguage() }))

  fastify.patch<{ Body: { language?: UiLanguage } }>('/config/ui', async (request, reply) => {
    const language = request.body?.language
    if (language === undefined || !VALID_UI_LANGUAGES.includes(language)) {
      return reply.status(400).send(invalidRequest(`language 必须是 ${VALID_UI_LANGUAGES.join('、')} 之一`))
    }
    try {
      updateUiLanguage(language)
    } catch (err) {
      if (!(err instanceof ConfigFileUnreadableError)) throw err
      console.error(err.message)
      return reply.status(500).send(errorBody(ERROR_CODES.CONFIG_FILE_UNREADABLE))
    }
    broadcastEvent('ui-language-changed', { language })
    return { language }
  })
}
