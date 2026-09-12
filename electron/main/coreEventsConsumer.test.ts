import { describe, it, expect, vi } from 'vitest'
import { createCoreEventsConsumer, type CoreEventsConsumerHandlers } from './coreEventsConsumer'

// 每个用例各自起一份全新的 handlers，避免用例之间通过共享 mock 互相污染调用计数
function createHandlers(): CoreEventsConsumerHandlers {
  return {
    converge: vi.fn(),
    onPresetSwitched: vi.fn(),
    onWindowBehaviorChanged: vi.fn(),
    log: {
      generationChanged: vi.fn(),
      helloHeartbeatParseError: vi.fn(),
      windowBehaviorParseError: vi.fn(),
    },
  }
}

// 拼一个符合 SSE 帧格式的 'event: xxx\ndata: yyy\n\n' 字符串，与 services/core/events/
// broadcast.ts 实际发送的格式一致
function frame(event: string, data: unknown): string {
  return `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`
}

describe('createCoreEventsConsumer', () => {
  it('onConnected() 只触发一次 converge', () => {
    const handlers = createHandlers()
    const consumer = createCoreEventsConsumer(handlers)

    consumer.onConnected()

    expect(handlers.converge).toHaveBeenCalledTimes(1)
  })

  it('任意数量的 hello/heartbeat 帧都不会触发额外的 converge 调用——这是本模块存在的核心原因', () => {
    const handlers = createHandlers()
    const consumer = createCoreEventsConsumer(handlers)

    consumer.onConnected()
    consumer.onChunk(frame('hello', { generation: 'gen-a' }))
    consumer.onChunk(frame('heartbeat', { generation: 'gen-a' }))
    consumer.onChunk(frame('heartbeat', { generation: 'gen-a' }))
    consumer.onChunk(frame('heartbeat', { generation: 'gen-a' }))

    // 唯一一次 converge 来自 onConnected() 本身，四个 hello/heartbeat 帧一次也没有额外触发
    expect(handlers.converge).toHaveBeenCalledTimes(1)
  })

  it('generation 变化时只打一行诊断日志，同样不触发 converge', () => {
    const handlers = createHandlers()
    const consumer = createCoreEventsConsumer(handlers)

    consumer.onConnected()
    consumer.onChunk(frame('hello', { generation: 'gen-a' }))
    consumer.onChunk(frame('heartbeat', { generation: 'gen-b' }))

    expect(handlers.log.generationChanged).toHaveBeenCalledTimes(1)
    expect(handlers.converge).toHaveBeenCalledTimes(1)
  })

  it('preset-switched 帧派发到 onPresetSwitched', () => {
    const handlers = createHandlers()
    const consumer = createCoreEventsConsumer(handlers)

    consumer.onChunk(frame('preset-switched', { sessionId: 's1', presetId: 'p1' }))

    expect(handlers.onPresetSwitched).toHaveBeenCalledTimes(1)
  })

  it('window-behavior-changed 帧派发到 onWindowBehaviorChanged 且解析出正确的 payload', () => {
    const handlers = createHandlers()
    const consumer = createCoreEventsConsumer(handlers)
    const config = { pinMode: 'dodge-fullscreen' as const, fullscreenWhitelist: ['a.exe'], blacklist: ['b.exe'] }

    consumer.onChunk(frame('window-behavior-changed', config))

    expect(handlers.onWindowBehaviorChanged).toHaveBeenCalledTimes(1)
    expect(handlers.onWindowBehaviorChanged).toHaveBeenCalledWith(config)
  })

  it('一帧跨两次 onChunk 调用拆开，仍然只派发一次', () => {
    const handlers = createHandlers()
    const consumer = createCoreEventsConsumer(handlers)
    const whole = frame('preset-switched', { sessionId: 's1', presetId: 'p1' })
    const splitPoint = Math.floor(whole.length / 2)

    consumer.onChunk(whole.slice(0, splitPoint))
    expect(handlers.onPresetSwitched).not.toHaveBeenCalled()
    consumer.onChunk(whole.slice(splitPoint))

    expect(handlers.onPresetSwitched).toHaveBeenCalledTimes(1)
  })

  it('data: 载荷不是合法 JSON 时被捕获并记录，不抛错、不影响后续帧', () => {
    const handlers = createHandlers()
    const consumer = createCoreEventsConsumer(handlers)

    expect(() => {
      consumer.onChunk('event: window-behavior-changed\ndata: not-json\n\n')
    }).not.toThrow()
    expect(handlers.log.windowBehaviorParseError).toHaveBeenCalledTimes(1)
    expect(handlers.onWindowBehaviorChanged).not.toHaveBeenCalled()

    // 同一个 consumer 实例接着喂一帧合法的，确认损坏的一帧没有把后续状态搞乱
    consumer.onChunk(frame('preset-switched', { sessionId: 's1', presetId: 'p1' }))
    expect(handlers.onPresetSwitched).toHaveBeenCalledTimes(1)
  })

  it('hello/heartbeat 的 data 不是合法 JSON 时同样被捕获并记录，不抛错', () => {
    const handlers = createHandlers()
    const consumer = createCoreEventsConsumer(handlers)

    expect(() => {
      consumer.onChunk('event: hello\ndata: not-json\n\n')
    }).not.toThrow()
    expect(handlers.log.helloHeartbeatParseError).toHaveBeenCalledTimes(1)
  })

  it('onConnected() 清空上一条连接遗留的半帧缓冲，不与新连接的字节流拼出错位假帧', () => {
    const handlers = createHandlers()
    const consumer = createCoreEventsConsumer(handlers)

    // 上一条连接在帧中途断线，只喂了一半
    consumer.onChunk('event: preset-switched\ndata: ')
    // 新连接建立：重连触发的收敛 + 缓冲重置
    consumer.onConnected()
    // 新连接自己发来的第一帧
    consumer.onChunk(frame('window-behavior-changed', { pinMode: 'off', fullscreenWhitelist: [], blacklist: [] }))

    expect(handlers.onPresetSwitched).not.toHaveBeenCalled()
    expect(handlers.onWindowBehaviorChanged).toHaveBeenCalledTimes(1)
  })
})
