// src/errorText.ts — 把 core 返回的错误响应体按当前界面语言翻成提示文字
// 用法：聊天窗口与设置窗口各处调 errorText(body, i18n.t)，body 先经 shared/errorCodes.ts 的 isErrorBody 判断
// 对应文件：shared/errorCodes.ts / src/chat/ChatWindow.tsx / src/settings/GeneralPanel.tsx / src/settings/ModelConfigPanel.tsx / src/settings/ModelNameField.tsx / src/settings/SubscriptionLogin.tsx / src/settings/WindowBehaviorPanel.tsx / src/settings/useCharacterPanel.ts
import type { TFunction } from 'i18next'
import type { ErrorBody } from '../shared/errorCodes.js'

export function errorText(body: ErrorBody, t: TFunction): string {
  switch (body.code) {
    case 'API_KEY_INVALID':
      return t('API key 无效或未配置')
    case 'SUMMARY_API_KEY_INVALID':
      return t('摘要模型的 API key 无效或未配置')
    case 'ENV_VAR_MISSING':
      return t('未检测到环境变量 {{envVar}}', { envVar: body.params?.envVar ?? '' })
    case 'MODEL_LIST_FAILED':
      return t('获取模型列表失败')
    case 'OLLAMA_START_FAILED':
      return t('Ollama 启动失败')
    case 'CARD_DATA_NOT_FOUND':
      return t('PNG 文件中未找到角色卡数据（缺少 ccv3/chara 文本块）')
    case 'CARD_BASE64_INVALID':
      return t('角色卡数据 base64 解码失败')
    case 'CARD_JSON_INVALID':
      return t('角色卡 JSON 解析失败，文件已损坏或格式不受支持')
    case 'CONFIG_FILE_UNREADABLE':
      return t('config.json 无法读取或格式不正确，本次没有保存，请修正该文件后重试')
    case 'AGENT_LOGIN_LAUNCH_FAILED':
      return t('无法启动登录窗口，请确认已安装对应命令行')
    case 'PRESET_NOT_FOUND':
      return t('角色不存在')
    case 'LAST_PRESET_UNDELETABLE':
      return t('至少需要保留一个角色')
    case 'WALLPAPER_SAVE_FAILED':
      return t('保存壁纸失败')
    case 'WALLPAPER_UNSUPPORTED_EXTENSION':
      return t('不支持的文件格式')
    case 'NO_ACTIVE_SESSION':
      return t('当前没有可用会话')
    case 'CONTEXT_BUILD_FAILED':
      return t('构建对话上下文失败')
    case 'SYSTEM_PROMPT_GENERATION_FAILED':
      return t('生成人设正文失败')
    case 'AVATAR_SAVE_FAILED':
      return t('保存头像失败')
    case 'CHARACTER_METADATA_SAVE_FAILED':
      return t('保存角色信息失败')
    case 'MODEL_CALL_FAILED':
      return t('模型调用失败')
    case 'SESSION_DELETED':
      return t('会话已删除')
    case 'VOICE_UNAVAILABLE':
      return t('语音组件未安装或未运行')
    case 'VOICE_BUSY':
      return t('当前状态下无法执行此操作')
    case 'VOICE_ALREADY_ENROLLED':
      return t('已录入声纹')
    case 'VOICE_ENROLL_NOT_READY':
      return t('说的话还不够，请继续说')
    case 'INVALID_REQUEST':
      return t('请求无效（错误代码：{{code}}）', { code: body.code })
    default:
      return t('操作失败（错误代码：{{code}}）', { code: String(body.code) })
  }
}
