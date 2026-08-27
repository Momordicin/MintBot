import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { EventEmitter } from 'events'
import { isAiServiceRunning } from './aiService.js'

// ensureAiService/stopAiServiceIfManaged 用例需要 mock child_process.spawn 与 fs.existsSync——
// mock 函数用 vi.hoisted 声明，保证各用例内 vi.resetModules() 重新 import 被测模块时，
// mock 引用不会跟着模块注册表一起被清空（hoisted 的 vi.fn() 实例本身还是同一个）
const { spawnMock, existsSyncMock } = vi.hoisted(() => ({
  spawnMock: vi.fn(),
  existsSyncMock: vi.fn(),
}))
vi.mock('child_process', () => ({ spawn: spawnMock }))
vi.mock('fs', () => ({ default: { existsSync: existsSyncMock } }))

// 伪造一个满足 aiService.ts 实际用到的接口子集的子进程：stdout/stderr 需要 .on('data', ...)，
// 进程本身需要 .on('error', ...)/.once('exit', ...)/.kill(signal?)。用真实 EventEmitter
// 承载事件部分，.kill 单独挂一个 vi.fn()
function makeFakeChild() {
  const child = new EventEmitter() as EventEmitter & { kill: ReturnType<typeof vi.fn> }
  ;(child as any).stdout = new EventEmitter()
  ;(child as any).stderr = new EventEmitter()
  child.kill = vi.fn()
  return child
}

// isAiServiceRunning 只判断进程本身是否在跑（HTTP 是否可连、状态码是否 ok），
// 与 EmbeddingProvider.ts 的 isEmbeddingReady（判断模型是否已加载）是两回事，
// 这里只覆盖它自己的三种结果：成功、非 ok 响应、请求异常（含超时）
describe('isAiServiceRunning', () => {
  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('响应 ok 时返回 true', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: true }))

    expect(await isAiServiceRunning('http://localhost:8765')).toBe(true)
  })

  it('响应非 ok 时返回 false', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: false, status: 503 }))

    expect(await isAiServiceRunning('http://localhost:8765')).toBe(false)
  })

  it('fetch 抛出异常（如超时）时返回 false，不向上抛出', async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('timeout')))

    expect(await isAiServiceRunning('http://localhost:8765')).toBe(false)
  })
})

// ensureAiService 在每个 core 进程生命周期内只会被调用一次，其内部可变状态
// （aiProcess/aiManagedByUs）不会在两次调用之间自动清空——每个用例都用
// vi.resetModules() + 动态 import 拿到一个全新的模块实例，避免用例之间相互依赖执行顺序
describe('ensureAiService', () => {
  const baseUrl = 'http://localhost:8765'

  beforeEach(() => {
    vi.resetModules()
    vi.useFakeTimers()
    spawnMock.mockReset()
    existsSyncMock.mockReset()
  })

  afterEach(() => {
    vi.unstubAllGlobals()
    vi.useRealTimers()
  })

  it('初次检查已在跑，500ms 后二次确认仍在跑：判定为别人管的，不会 spawn', async () => {
    const fetchMock = vi.fn().mockResolvedValue({ ok: true })
    vi.stubGlobal('fetch', fetchMock)
    const { ensureAiService } = await import('./aiService.js')

    const promise = ensureAiService(baseUrl)
    await vi.advanceTimersByTimeAsync(500)
    await promise

    // 关键断言：真的发生了二次确认（调用了两次 /health），不是只查了一次就直接放行——
    // 否则改回"只查一次就判定别人管的"这个旧实现，这个用例照样能通过，测不出回归
    expect(fetchMock).toHaveBeenCalledTimes(2)
    expect(spawnMock).not.toHaveBeenCalled()
  })

  it('初次检查已在跑，500ms 后二次确认已不在跑：判定为误判，走 spawn 路径并等到就绪', async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce({ ok: true }) // 初次检查
      .mockResolvedValueOnce({ ok: false }) // 500ms 后二次确认
      .mockResolvedValue({ ok: true }) // waitForAiService 轮询
    vi.stubGlobal('fetch', fetchMock)
    existsSyncMock.mockReturnValue(true)
    spawnMock.mockReturnValue(makeFakeChild())
    const { ensureAiService } = await import('./aiService.js')

    const promise = ensureAiService(baseUrl)
    await vi.advanceTimersByTimeAsync(500)
    await promise

    expect(spawnMock).toHaveBeenCalledTimes(1)
    const [pythonPath, args, options] = spawnMock.mock.calls[0]
    expect(pythonPath).toContain('python')
    expect(args).toEqual(expect.arrayContaining(['-m', 'uvicorn']))
    // 防止日后误删/打错这两个环境变量——它们是本地模型加载不该发起联网请求的唯一保障
    expect(options.env).toMatchObject({ HF_HUB_OFFLINE: '1', TRANSFORMERS_OFFLINE: '1' })
  })
})

// stopAiServiceIfManaged 只在"确实是自己 spawn 的"场景下才有动作——两个用例都先重放
// ensureAiService 的 spawn 路径，把模块内部状态推进到 aiManagedByUs=true/aiProcess=fakeChild，
// 再验证停止逻辑本身
describe('stopAiServiceIfManaged', () => {
  const baseUrl = 'http://localhost:8765'
  const FORCE_KILL_TIMEOUT_MS = 3000 // 与 aiService.ts 内部私有常量保持一致

  beforeEach(() => {
    vi.resetModules()
    vi.useFakeTimers()
    spawnMock.mockReset()
    existsSyncMock.mockReset()
  })

  afterEach(() => {
    vi.unstubAllGlobals()
    vi.useRealTimers()
  })

  // 让被测模块进入"已 spawn 且由自己管理"的状态，返回拿到的 fakeChild 和待测函数
  async function setUpManagedRunningService() {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce({ ok: true })
      .mockResolvedValueOnce({ ok: false })
      .mockResolvedValue({ ok: true })
    vi.stubGlobal('fetch', fetchMock)
    existsSyncMock.mockReturnValue(true)
    const fakeChild = makeFakeChild()
    spawnMock.mockReturnValue(fakeChild)

    const { ensureAiService, stopAiServiceIfManaged } = await import('./aiService.js')
    const ensurePromise = ensureAiService(baseUrl)
    await vi.advanceTimersByTimeAsync(500)
    await ensurePromise

    return { fakeChild, stopAiServiceIfManaged }
  }

  it('等到子进程真正触发 exit 事件才 resolve，且用无参数 kill() 温和终止', async () => {
    const { fakeChild, stopAiServiceIfManaged } = await setUpManagedRunningService()

    let resolved = false
    const stopPromise = stopAiServiceIfManaged().then(() => { resolved = true })

    expect(fakeChild.kill).toHaveBeenCalledWith()

    // 还没触发 exit，即使等一段时间也不应该 resolve
    await vi.advanceTimersByTimeAsync(100)
    expect(resolved).toBe(false)

    fakeChild.emit('exit')
    await stopPromise
    expect(resolved).toBe(true)
  })

  it('超过 FORCE_KILL_TIMEOUT_MS 仍未退出时会追加 SIGKILL 强制结束', async () => {
    const { fakeChild, stopAiServiceIfManaged } = await setUpManagedRunningService()

    let resolved = false
    const stopPromise = stopAiServiceIfManaged().then(() => { resolved = true })

    expect(fakeChild.kill).toHaveBeenCalledTimes(1)
    expect(fakeChild.kill).toHaveBeenCalledWith()

    await vi.advanceTimersByTimeAsync(FORCE_KILL_TIMEOUT_MS)
    expect(fakeChild.kill).toHaveBeenCalledTimes(2)
    expect(fakeChild.kill).toHaveBeenLastCalledWith('SIGKILL')
    expect(resolved).toBe(false)

    // 模拟强制 kill 最终生效
    fakeChild.emit('exit')
    await stopPromise
    expect(resolved).toBe(true)
  })
})
