// services/core/providers/envCredentials.test.ts — 凭据环境变量清除的单元测试
// 用法：vitest 自动运行
// 对应文件：services/core/providers/envCredentials.ts
import { describe, it, expect, afterEach } from 'vitest'
import { wipeCredentialEnv, getEnvCredential, isEnvCredentialDetected, CREDENTIAL_ENV_VARS } from './envCredentials.js'

const saved: Record<string, string | undefined> = {}
for (const name of CREDENTIAL_ENV_VARS) saved[name] = process.env[name]

afterEach(() => {
  for (const name of CREDENTIAL_ENV_VARS) {
    if (saved[name] === undefined) delete process.env[name]
    else process.env[name] = saved[name]
  }
})

describe('wipeCredentialEnv', () => {
  it('清除全部 7 个凭据环境变量，不动其他变量', () => {
    for (const name of CREDENTIAL_ENV_VARS) process.env[name] = 'secret'
    process.env.MINTBOT_WIPE_TEST_OTHER = 'keep'

    wipeCredentialEnv()

    expect(CREDENTIAL_ENV_VARS).toHaveLength(7)
    for (const name of CREDENTIAL_ENV_VARS) expect(process.env[name]).toBeUndefined()
    expect(process.env.MINTBOT_WIPE_TEST_OTHER).toBe('keep')
    delete process.env.MINTBOT_WIPE_TEST_OTHER
  })
})

describe('wipeCredentialEnv 暂存三家 API Key', () => {
  it('清除前把三家 API Key 去除首尾空白后暂存，清除后进程环境里读不到', () => {
    process.env.ANTHROPIC_API_KEY = '  sk-ant-env  '
    process.env.OPENAI_API_KEY = 'sk-openai-env'
    process.env.DEEPSEEK_API_KEY = '\tsk-deepseek-env\n'

    wipeCredentialEnv()

    expect(getEnvCredential('anthropic')).toBe('sk-ant-env')
    expect(getEnvCredential('openai')).toBe('sk-openai-env')
    expect(getEnvCredential('deepseek')).toBe('sk-deepseek-env')
    expect(isEnvCredentialDetected('anthropic')).toBe(true)
    expect(process.env.ANTHROPIC_API_KEY).toBeUndefined()
    expect(process.env.OPENAI_API_KEY).toBeUndefined()
    expect(process.env.DEEPSEEK_API_KEY).toBeUndefined()
  })

  it('未设置或只有空白的变量暂存为空串，视为未检测到，其余提供方不受影响', () => {
    delete process.env.ANTHROPIC_API_KEY
    process.env.OPENAI_API_KEY = '   '
    process.env.DEEPSEEK_API_KEY = 'sk-deepseek-env'

    wipeCredentialEnv()

    expect(getEnvCredential('anthropic')).toBe('')
    expect(getEnvCredential('openai')).toBe('')
    expect(isEnvCredentialDetected('anthropic')).toBe(false)
    expect(isEnvCredentialDetected('openai')).toBe(false)
    expect(isEnvCredentialDetected('deepseek')).toBe(true)
    expect(process.env.OPENAI_API_KEY).toBeUndefined()
  })
})
