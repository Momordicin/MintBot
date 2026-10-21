// services/core/voice/installFiles.test.ts — 语音组件远端版本读取与旧版本目录清理的真实文件测试
// 用法：pnpm test；用系统临时目录与 stub 的 fetch 直接调用 install.ts 的 fetchRemoteManifestInfo、removeStaleVoiceVersions
// 对应文件：services/core/voice/install.ts / services/core/voice/install.test.ts
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import fs from 'fs'
import os from 'os'
import path from 'path'
import { fetchRemoteManifestInfo, removeStaleVoiceVersions } from './install.js'

let tmp: string

beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'mintbot-voice-files-test-'))
})

afterEach(() => {
  vi.unstubAllGlobals()
  fs.rmSync(tmp, { recursive: true, force: true })
})

describe('removeStaleVoiceVersions', () => {
  it('removes only version directories that current.json does not point at', async () => {
    const manifest = { packages: { agent: { version: '0.2.0' }, models: { version: '1.0.0' } } }
    fs.writeFileSync(path.join(tmp, 'current.json'), JSON.stringify({ manifest }))
    const kept = [
      path.join(tmp, 'agent', '0.2.0'),
      path.join(tmp, 'models', '1.0.0'),
      path.join(tmp, 'agent', '.0.3.0.tmp-abc123'),
    ]
    const stale = [path.join(tmp, 'agent', '0.1.1'), path.join(tmp, 'agent', '0.1.0'), path.join(tmp, 'models', '0.9.0')]
    for (const dir of [...kept, ...stale]) {
      fs.mkdirSync(dir, { recursive: true })
      fs.writeFileSync(path.join(dir, 'file.bin'), 'x')
    }
    await removeStaleVoiceVersions(tmp)
    for (const dir of kept) expect(fs.existsSync(dir)).toBe(true)
    for (const dir of stale) expect(fs.existsSync(dir)).toBe(false)
  })
})

describe('fetchRemoteManifestInfo', () => {
  function stubFetch(response: { ok: boolean; status?: number; body?: string }) {
    const fetchMock = vi.fn(async () => ({
      ok: response.ok,
      status: response.status ?? 200,
      text: async () => response.body ?? '',
    }))
    vi.stubGlobal('fetch', fetchMock)
    return fetchMock
  }

  it('reads version and api_version from an http manifest', async () => {
    const fetchMock = stubFetch({ ok: true, body: JSON.stringify({ version: '0.2.0', api_version: 1, extra: true }) })
    await expect(fetchRemoteManifestInfo('https://example.invalid/manifest.json')).resolves.toEqual({
      version: '0.2.0',
      apiVersion: 1,
    })
    expect(fetchMock).toHaveBeenCalledTimes(1)
  })

  it('rejects on a non-ok HTTP status', async () => {
    stubFetch({ ok: false, status: 404 })
    await expect(fetchRemoteManifestInfo('https://example.invalid/manifest.json')).rejects.toThrow('HTTP 404')
  })

  it('rejects on unparsable or incomplete manifests', async () => {
    for (const body of ['not json', JSON.stringify({ api_version: 1 }), JSON.stringify({ version: '0.2.0' }), JSON.stringify({ version: 2, api_version: 1 })]) {
      stubFetch({ ok: true, body })
      await expect(fetchRemoteManifestInfo('https://example.invalid/manifest.json')).rejects.toThrow()
    }
  })

  it('reads a local file path without fetching', async () => {
    const fetchMock = stubFetch({ ok: true })
    const file = path.join(tmp, 'manifest.json')
    fs.writeFileSync(file, JSON.stringify({ version: '0.3.0', api_version: 1 }))
    await expect(fetchRemoteManifestInfo(file)).resolves.toEqual({ version: '0.3.0', apiVersion: 1 })
    expect(fetchMock).not.toHaveBeenCalled()
  })
})
