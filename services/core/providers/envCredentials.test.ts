// services/core/providers/envCredentials.test.ts — 凭据环境变量清除的单元测试
// 用法：vitest 自动运行
// 对应文件：services/core/providers/envCredentials.ts
import { describe, it, expect, afterEach } from 'vitest'
import { wipeCredentialEnv, CREDENTIAL_ENV_VARS } from './envCredentials.js'

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
