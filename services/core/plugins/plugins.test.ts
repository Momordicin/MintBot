// services/core/plugins/plugins.test.ts — 插件框架测试：包检查与安装、版本检查与"仍然启用"、配置整理、ctx.fetch、PLUGINS_PATH 隔离
// 用法：pnpm test；压缩包在测试里用 fflate 生成，ctx.fetch 用本机临时 HTTP 服务，不连网
// 对应文件：services/core/plugins/install.ts / services/core/plugins/package.ts / services/core/plugins/versionRange.ts / services/core/plugins/manager.ts / services/core/plugins/routes.ts / services/core/plugins/pluginFetch.ts / services/core/plugins/paths.ts
import fs from 'node:fs/promises'
import http from 'node:http'
import type { AddressInfo } from 'node:net'
import path from 'path'
import Fastify from 'fastify'
import { strToU8, zipSync } from 'fflate'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { installArchive } from './install.js'
import { PluginPackageError, type PluginStandard } from './package.js'
import { PLUGINS_DIR, PLUGINS_ROOT, pluginConfigPath, pluginInstallDir } from './paths.js'
import { createPluginFetch } from './pluginFetch.js'
import { checkVersionRange, type VersionCheck } from './versionRange.js'

const NAME = 'mintbot_weather'
const ROOT = 'mintbot-weather-master'

const STANDARD: PluginStandard = {
  retries: 1,
  retry_delay_ms: 20,
  request_timeout_ms: 2000,
  connect_attempt_timeout_ms: 1000,
  call_timeout_ms: 60000,
  max_repeat: 3,
  cache: 'places/',
  errors: { network: 'x' },
}

function metadata(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    name: NAME,
    version: '0.1.0',
    mintbot_version: '>=1.0.0,<2',
    entry: 'main.ts',
    standard: STANDARD,
    ...overrides,
  }
}

type Files = Record<string, string>

function packageFiles(metadataOverrides: Record<string, unknown> = {}, extra: Files = {}): Files {
  return {
    'metadata.json': JSON.stringify(metadata(metadataOverrides)),
    'main.ts': 'export const tools = []',
    ...extra,
  }
}

function makeZip(files: Files, options: { root?: string | null; rootDirEntry?: boolean } = {}): Uint8Array {
  const root = options.root === undefined ? ROOT : options.root
  const entries: Record<string, Uint8Array> = {}
  if (root !== null && options.rootDirEntry !== false) entries[`${root}/`] = new Uint8Array()
  for (const [name, content] of Object.entries(files)) {
    entries[root === null ? name : `${root}/${name}`] = strToU8(content)
  }
  return zipSync(entries)
}

async function exists(target: string): Promise<boolean> {
  return fs.access(target).then(() => true, () => false)
}

beforeEach(async () => {
  await fs.rm(PLUGINS_DIR, { recursive: true, force: true })
})

afterEach(() => {
  vi.restoreAllMocks()
})

describe('插件包不合格时拒绝安装', () => {
  const noMetadata = packageFiles()
  delete noMetadata['metadata.json']

  const cases: { title: string; files: Files }[] = [
    { title: '缺 metadata.json', files: noMetadata },
    { title: 'name 不对', files: packageFiles({ name: 'other_plugin' }) },
    { title: '缺 version', files: packageFiles({ version: undefined }) },
    { title: 'mintbot_version 不是字符串', files: packageFiles({ mintbot_version: 1 }) },
    { title: 'standard 缺 retries', files: packageFiles({ standard: { ...STANDARD, retries: undefined } }) },
    { title: 'standard 缺 cache', files: packageFiles({ standard: { ...STANDARD, cache: undefined } }) },
    { title: 'standard.errors 不是对象', files: packageFiles({ standard: { ...STANDARD, errors: 'x' } }) },
    { title: 'entry 指向的文件不在包里', files: packageFiles({ entry: 'missing.ts' }) },
    { title: 'entry 越出插件目录', files: packageFiles({ entry: '../outside.ts' }) },
    { title: 'entry 是绝对路径', files: packageFiles({ entry: '/main.ts' }) },
  ]

  it.each(cases)('$title', async ({ files }) => {
    await expect(installArchive(NAME, makeZip(files))).rejects.toBeInstanceOf(PluginPackageError)
    expect(await exists(pluginInstallDir(NAME))).toBe(false)
  })
})

describe('压缩包路径与根目录', () => {
  const unsafe: { title: string; entry: string }[] = [
    { title: '含 ..', entry: '../evil.txt' },
    { title: '绝对路径', entry: '/evil.txt' },
    { title: '盘符路径', entry: 'C:/evil.txt' },
    { title: '反斜杠形式的 ..', entry: `${ROOT}\\..\\..\\evil.txt` },
  ]

  it.each(unsafe)('$title 时拒绝安装', async ({ entry }) => {
    const zip = zipSync({
      [`${ROOT}/metadata.json`]: strToU8(JSON.stringify(metadata())),
      [`${ROOT}/main.ts`]: strToU8('export const tools = []'),
      [entry]: strToU8('x'),
    })
    await expect(installArchive(NAME, zip)).rejects.toBeInstanceOf(PluginPackageError)
    expect(await exists(pluginInstallDir(NAME))).toBe(false)
  })

  const layouts: { title: string; zip: () => Uint8Array }[] = [
    { title: '带根目录条目', zip: () => makeZip(packageFiles({ entry: 'src/main.ts' }, { 'src/main.ts': 'export const tools = []' })) },
    {
      title: '没有单独根目录条目',
      zip: () => makeZip(packageFiles({ entry: 'src/main.ts' }, { 'src/main.ts': 'export const tools = []' }), { rootDirEntry: false }),
    },
    { title: '没有根目录，文件直接在顶层', zip: () => makeZip(packageFiles(), { root: null }) },
  ]

  it.each(layouts)('$title 的包能正常安装', async ({ zip }) => {
    const result = await installArchive(NAME, zip())
    expect(result).toMatchObject({ replaced: false, metadata: { name: NAME, version: '0.1.0' } })
    expect(await exists(path.join(pluginInstallDir(NAME), 'metadata.json'))).toBe(true)
    expect(await exists(path.join(pluginInstallDir(NAME), result.metadata.entry))).toBe(true)
  })
})

describe('更新时旧插件保持完好', () => {
  async function installOld(): Promise<void> {
    await installArchive(NAME, makeZip(packageFiles({ version: '0.1.0' }, { 'marker.txt': 'old' })))
  }

  async function expectOldIntact(): Promise<void> {
    expect(await fs.readFile(path.join(pluginInstallDir(NAME), 'marker.txt'), 'utf8')).toBe('old')
    expect(JSON.parse(await fs.readFile(path.join(pluginInstallDir(NAME), 'metadata.json'), 'utf8')).version).toBe('0.1.0')
    expect((await fs.readdir(PLUGINS_DIR)).filter(entry => entry.startsWith('.'))).toEqual([])
  }

  it('新包不合格', async () => {
    await installOld()
    const bad = makeZip(packageFiles({ version: '0.2.0', entry: 'missing.ts' }, { 'marker.txt': 'new' }))
    await expect(installArchive(NAME, bad)).rejects.toBeInstanceOf(PluginPackageError)
    await expectOldIntact()
  })

  it('替换中途失败', async () => {
    await installOld()
    const realRename = fs.rename.bind(fs)
    let calls = 0
    vi.spyOn(fs, 'rename').mockImplementation(async (from, to) => {
      calls++
      if (calls === 2) throw new Error('rename failed')
      return realRename(from, to)
    })
    const next = makeZip(packageFiles({ version: '0.2.0' }, { 'marker.txt': 'new' }))
    await expect(installArchive(NAME, next)).rejects.toThrow('rename failed')
    await expectOldIntact()
  })

})

describe('_conf_schema.json', () => {
  it('带 UTF-8 BOM 也能读', async () => {
    const zip = makeZip(packageFiles({}, { '_conf_schema.json': '\uFEFF{"default_city":{"type":"string","default":""}}' }))
    await expect(installArchive(NAME, zip)).resolves.toMatchObject({ replaced: false })
  })

  it('不是合法 JSON 时拒绝安装', async () => {
    const zip = makeZip(packageFiles({}, { '_conf_schema.json': '{not json' }))
    await expect(installArchive(NAME, zip)).rejects.toBeInstanceOf(PluginPackageError)
    expect(await exists(pluginInstallDir(NAME))).toBe(false)
  })
})

describe('版本范围判断', () => {
  const cases: { range: string | undefined; version: string; expected: VersionCheck }[] = [
    { range: '>=1.0.0,<2', version: '1.0.0', expected: 'ok' },
    { range: '>=1.0.0,<2', version: '2.0.0', expected: 'incompatible' },
    { range: '>=1.0.0,<2', version: '1.1.0rc1', expected: 'ok' },
    { range: '>=0.9', version: '1.0.0-beta.1', expected: 'ok' },
    { range: '>=1.0.0;<2', version: '1.0.0', expected: 'invalid' },
    { range: undefined, version: '1.0.0', expected: 'ok' },
    { range: '', version: '1.0.0', expected: 'ok' },
  ]

  it.each(cases)('$range 对 $version → $expected', ({ range, version, expected }) => {
    expect(checkVersionRange(range, version)).toBe(expected)
  })
})

describe('版本检查与"仍然启用"', () => {
  async function installPlugin(metadataOverrides: Record<string, unknown>, extra: Files = {}): Promise<void> {
    await installArchive(
      NAME,
      makeZip(packageFiles({ entry: 'main.mjs', ...metadataOverrides }, { 'main.mjs': 'export const tools = []', ...extra }))
    )
  }

  async function freshCore() {
    vi.resetModules()
    const manager = await import('./manager.js')
    const { pluginRoutes } = await import('./routes.js')
    const app = Fastify()
    await app.register(pluginRoutes)
    await manager.loadInstalledPlugins()
    const plugin = () => manager.getPluginsSnapshot()[0]
    return { app, plugin }
  }

  beforeEach(async () => {
    await fs.rm(path.join(PLUGINS_ROOT, 'config'), { recursive: true, force: true })
  })

  it('记录的版本等于当前版本时，重启后仍然启用并标记 forced；版本变了就重新判断', async () => {
    await installPlugin({ version: '0.1.0', mintbot_version: '>=9' })
    const first = await freshCore()
    expect(first.plugin()).toMatchObject({ enabled: false, forced: false, disabled: { reason: 'version_incompatible', range: '>=9' } })

    expect((await first.app.inject({ method: 'POST', url: `/plugins/${NAME}/force-enable` })).statusCode).toBe(200)
    expect(first.plugin()).toMatchObject({ enabled: true, forced: true, disabled: null })

    const restarted = await freshCore()
    expect(restarted.plugin()).toMatchObject({ enabled: true, forced: true })

    await installPlugin({ version: '0.2.0', mintbot_version: '>=9' })
    const updated = await freshCore()
    expect(updated.plugin()).toMatchObject({ version: '0.2.0', enabled: false, forced: false, disabled: { reason: 'version_incompatible' } })
  })

  it('仍然启用后加载失败：forced 的 load_failed 带错误首行，取消后记录被删、重新加载时不再导入', async () => {
    const overridesPath = path.join(PLUGINS_ROOT, 'config', 'plugin_overrides.json')
    await installPlugin(
      { mintbot_version: '>=9', entry: 'throws.mjs' },
      { 'throws.mjs': `throw new Error('boom ${'x'.repeat(300)}\\nsecond line')` }
    )
    const core = await freshCore()
    expect((await core.app.inject({ method: 'POST', url: `/plugins/${NAME}/force-enable` })).statusCode).toBe(200)
    const failed = core.plugin()
    expect(failed).toMatchObject({ enabled: false, forced: false, disabled: { reason: 'load_failed', forced: true } })
    const message = (failed.disabled as { message: string }).message
    expect(message).toHaveLength(200)
    expect(message.startsWith('boom x')).toBe(true)

    const restarted = await freshCore()
    expect(restarted.plugin().disabled).toMatchObject({ reason: 'load_failed', forced: true })

    expect((await restarted.app.inject({ method: 'POST', url: `/plugins/${NAME}/cancel-force-enable` })).statusCode).toBe(200)
    expect(restarted.plugin()).toMatchObject({ enabled: false, disabled: { reason: 'version_incompatible' } })
    expect(JSON.parse(await fs.readFile(overridesPath, 'utf8'))).toEqual({})

    const again = await freshCore()
    expect(again.plugin().disabled).toMatchObject({ reason: 'version_incompatible' })
    expect((await again.app.inject({ method: 'POST', url: `/plugins/${NAME}/cancel-force-enable` })).json()).toEqual({
      code: 'PLUGIN_FORCE_ENABLE_REJECTED',
    })
  })

  it('写法有误的范围也能仍然启用', async () => {
    await installPlugin({ mintbot_version: '>=1.0;<2' })
    const core = await freshCore()
    expect(core.plugin()).toMatchObject({ enabled: false, disabled: { reason: 'version_invalid', range: '>=1.0;<2' } })
    expect((await core.app.inject({ method: 'POST', url: `/plugins/${NAME}/force-enable` })).statusCode).toBe(200)
    expect(core.plugin()).toMatchObject({ enabled: true, forced: true })
  })

  it('force-enable 只对因版本没启用的插件有效', async () => {
    const url = `/plugins/${NAME}/force-enable`
    const notInstalled = await freshCore()
    expect((await notInstalled.app.inject({ method: 'POST', url })).statusCode).toBe(409)

    await installPlugin({ mintbot_version: '>=1.0.0,<2' })
    const compatible = await freshCore()
    expect(compatible.plugin()).toMatchObject({ enabled: true, forced: false })
    expect((await compatible.app.inject({ method: 'POST', url })).json()).toEqual({ code: 'PLUGIN_FORCE_ENABLE_REJECTED' })

    await installPlugin({ mintbot_version: '>=1.0.0,<2', entry: 'broken.mjs' }, { 'broken.mjs': 'export const nothing = 1' })
    const loadFailed = await freshCore()
    expect(loadFailed.plugin().disabled).toEqual({ reason: 'load_failed' })
    expect((await loadFailed.app.inject({ method: 'POST', url })).statusCode).toBe(409)
  })

  it('没有 mintbot_version 视为兼容', async () => {
    await installPlugin({ mintbot_version: undefined })
    expect((await freshCore()).plugin()).toMatchObject({ enabled: true, forced: false, disabled: null })
  })

  it('加载时按配置说明整理已存配置：补上缺的项、删掉多的项并写回文件', async () => {
    const schema = JSON.stringify({
      default_city: { type: 'string', default: '' },
      units: { type: 'string', default: 'metric' },
    })
    await installPlugin({}, { '_conf_schema.json': schema })
    const configPath = pluginConfigPath(NAME)
    await fs.mkdir(path.dirname(configPath), { recursive: true })
    await fs.writeFile(configPath, JSON.stringify({ default_city: '上海', old_key: 'x' }))

    const core = await freshCore()
    const expected = { default_city: '上海', units: 'metric' }
    expect(core.plugin().config).toEqual(expected)
    expect(JSON.parse(await fs.readFile(configPath, 'utf8'))).toEqual(expected)
  })
})

describe('ctx.fetch', () => {
  let server: http.Server
  let base: string
  let hits: Record<string, number>
  let received: string[]

  beforeEach(async () => {
    hits = {}
    received = []
    server = http.createServer((request, response) => {
      const url = request.url ?? ''
      hits[url] = (hits[url] ?? 0) + 1
      if (url === '/echo') {
        let body = ''
        request.on('data', chunk => { body += chunk })
        request.on('end', () => {
          received.push(`${request.method} ${body}`)
          if (received.length === 1) response.writeHead(503).end('busy')
          else response.writeHead(200).end('ok')
        })
        return
      }
      if (url === '/flaky') {
        if (hits[url] === 1) response.writeHead(503).end('busy')
        else response.writeHead(200).end('ok')
      } else if (url === '/down') {
        response.writeHead(503).end('down')
      } else if (url === '/slow') {
        setTimeout(() => response.writeHead(200).end('slow'), 300)
      } else {
        response.writeHead(200).end('ok')
      }
    })
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
  })

  afterEach(async () => {
    server.closeAllConnections()
    await new Promise<void>(resolve => server.close(() => resolve()))
  })

  const signal = () => new AbortController().signal

  it('503 后重试成功', async () => {
    const result = await createPluginFetch(STANDARD)(`${base}/flaky`, undefined, signal())
    expect(result).toEqual({ ok: true, status: 200, body: 'ok' })
    expect(hits['/flaky']).toBe(2)
  })

  it.each([
    ['不带 method / body 时仍是 GET', undefined, ['GET ', 'GET ']],
    ['带 method / body 时按 POST 发出，重试时仍带', { method: 'POST' as const, body: '{"q":1}' }, ['POST {"q":1}', 'POST {"q":1}']],
  ])('%s', async (_name, init, expected) => {
    const result = await createPluginFetch(STANDARD)(`${base}/echo`, init, signal())
    expect(result).toEqual({ ok: true, status: 200, body: 'ok' })
    expect(received).toEqual(expected)
  })

  it('超过重试次数后返回 http', async () => {
    const result = await createPluginFetch(STANDARD)(`${base}/down`, undefined, signal())
    expect(result).toMatchObject({ ok: false, kind: 'http', status: 503 })
    expect(hits['/down']).toBe(2)
  })

  it('重试等待期间中止，立刻返回 aborted', async () => {
    const controller = new AbortController()
    const started = Date.now()
    setTimeout(() => controller.abort(), 100)
    const result = await createPluginFetch({ ...STANDARD, retry_delay_ms: 5000 })(`${base}/down`, undefined, controller.signal)
    expect(result).toMatchObject({ ok: false, kind: 'aborted' })
    expect(Date.now() - started).toBeLessThan(2000)
    expect(hits['/down']).toBe(1)
  })

  it('不同插件各自的超时互不影响', async () => {
    const short = createPluginFetch({ ...STANDARD, retries: 0, request_timeout_ms: 100 })
    const long = createPluginFetch({ ...STANDARD, retries: 0, request_timeout_ms: 2000 })
    const [shortResult, longResult] = await Promise.all([
      short(`${base}/slow`, undefined, signal()),
      long(`${base}/slow`, undefined, signal()),
    ])
    expect(shortResult).toMatchObject({ ok: false, kind: 'timeout' })
    expect(longResult).toEqual({ ok: true, status: 200, body: 'slow' })
  })
})

describe('PLUGINS_PATH 测试隔离', () => {
  const original = process.env.PLUGINS_PATH

  afterEach(() => {
    if (original === undefined) delete process.env.PLUGINS_PATH
    else process.env.PLUGINS_PATH = original
    vi.resetModules()
  })

  it('vitest 下 PLUGINS_PATH 不在临时目录时拒绝加载', async () => {
    process.env.PLUGINS_PATH = './data'
    vi.resetModules()
    await expect(import('./paths.js')).rejects.toThrow(/refusing PLUGINS_PATH/)
  })
})
