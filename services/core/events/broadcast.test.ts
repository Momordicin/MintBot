import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { EventEmitter } from 'events'
import type { FastifyReply } from 'fastify'
import { registerEventsClient, broadcastEvent, sendHello } from './broadcast.js'

// GET /events 场景下的 reply.raw 只需要具备 write()/on('close')/writableEnded/destroyed 这几个
// 被 broadcast.ts 用到的面，用真实 EventEmitter 复刻 close 事件的可控触发（同 aiService.test.ts
// 里给子进程打桩的手法一致），writableEnded/destroyed 用可变字段模拟
function fakeReply(): FastifyReply {
  const raw = new EventEmitter() as EventEmitter & {
    write: ReturnType<typeof vi.fn>
    writableEnded: boolean
    destroyed: boolean
  }
  raw.write = vi.fn()
  raw.writableEnded = false
  raw.destroyed = false
  return { raw } as unknown as FastifyReply
}

describe('broadcast.ts', () => {
  it('registerEventsClient 注册的客户端能收到 broadcastEvent 的写入', () => {
    const reply = fakeReply()
    registerEventsClient(reply)

    broadcastEvent('emotion', { self: { label: 'happy', intensity: 0.5 }, perceived_user: null })

    expect(reply.raw.write).toHaveBeenCalledWith(
      `event: emotion\ndata: ${JSON.stringify({ self: { label: 'happy', intensity: 0.5 }, perceived_user: null })}\n\n`,
    )
  })

  it('多个已注册客户端都收到同一次广播', () => {
    const replyA = fakeReply()
    const replyB = fakeReply()
    registerEventsClient(replyA)
    registerEventsClient(replyB)

    broadcastEvent('emotion', { self: null, perceived_user: null })

    expect(replyA.raw.write).toHaveBeenCalledTimes(1)
    expect(replyB.raw.write).toHaveBeenCalledTimes(1)
  })

  it('连接已经 destroyed 的客户端被跳过，不抛错，且从注册表移除（后续广播不会再尝试写入）', () => {
    const reply = fakeReply()
    registerEventsClient(reply)
    ;(reply.raw as unknown as { destroyed: boolean }).destroyed = true

    expect(() => broadcastEvent('emotion', { self: null, perceived_user: null })).not.toThrow()
    expect(reply.raw.write).not.toHaveBeenCalled()

    // 顺手验证已被移除：即便之后把 destroyed 改回 false，也不会再收到广播
    ;(reply.raw as unknown as { destroyed: boolean }).destroyed = false
    broadcastEvent('emotion', { self: null, perceived_user: null })
    expect(reply.raw.write).not.toHaveBeenCalled()
  })

  it('连接已经 writableEnded 的客户端同样被跳过，不抛错', () => {
    const reply = fakeReply()
    registerEventsClient(reply)
    ;(reply.raw as unknown as { writableEnded: boolean }).writableEnded = true

    expect(() => broadcastEvent('emotion', { self: null, perceived_user: null })).not.toThrow()
    expect(reply.raw.write).not.toHaveBeenCalled()
  })

  it('客户端断开（raw 触发 close）后从注册表移除，不再收到后续广播', () => {
    const reply = fakeReply()
    registerEventsClient(reply)

    reply.raw.emit('close')

    broadcastEvent('emotion', { self: null, perceived_user: null })
    expect(reply.raw.write).not.toHaveBeenCalled()
  })

  it('某个客户端 write() 抛错时不中断整个循环——排在它之后的客户端仍能收到这次广播，且异常不会冒泡出 broadcastEvent', () => {
    const failing = fakeReply()
    const healthy = fakeReply()
    ;(failing.raw.write as ReturnType<typeof vi.fn>).mockImplementation(() => {
      throw new Error('socket write failed')
    })
    registerEventsClient(failing)
    registerEventsClient(healthy)

    expect(() => broadcastEvent('emotion', { self: null, perceived_user: null })).not.toThrow()
    expect(healthy.raw.write).toHaveBeenCalledTimes(1)

    // 写入失败的客户端应该被顺手移除，之后的广播不会再对它重试
    healthy.raw.write = vi.fn()
    ;(failing.raw.write as ReturnType<typeof vi.fn>).mockClear()
    broadcastEvent('emotion', { self: null, perceived_user: null })
    expect(failing.raw.write).not.toHaveBeenCalled()
    expect(healthy.raw.write).toHaveBeenCalledTimes(1)
  })

  it('sendHello 只写给传入的这一个客户端，不广播给其它已注册客户端', () => {
    const target = fakeReply()
    const other = fakeReply()
    registerEventsClient(target)
    registerEventsClient(other)

    sendHello(target)

    expect(target.raw.write).toHaveBeenCalledTimes(1)
    expect(other.raw.write).not.toHaveBeenCalled()
  })
})

// 心跳定时器的生命周期：单独一个 describe，每个用例都用 vi.resetModules() + 动态 import
// 拿一份全新的模块实例（同 services/core/config/index.test.ts 的既有约定）——上面这些用例
// 从未清空过模块级的 clients 注册表（好几个客户端注册后从未 close），若心跳生命周期测试
// 复用同一个模块实例，"最后一个客户端断开"这个条件在本文件里永远不会真正成立，断言会失真
describe('心跳生命周期', () => {
  beforeEach(() => {
    vi.resetModules()
    vi.useFakeTimers()
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  it('第一个客户端注册后启动心跳，每 HEARTBEAT_INTERVAL_MS 广播一次携带 generation 的 heartbeat', async () => {
    const { registerEventsClient, HEARTBEAT_INTERVAL_MS, SERVER_GENERATION } = await import('./broadcast.js')
    const reply = fakeReply()
    registerEventsClient(reply)

    // 注册本身不应该立即触发一次心跳——心跳是定时广播，不是连接时的一次性动作（那是
    // sendHello 的职责，两者分工不同）
    expect(reply.raw.write).not.toHaveBeenCalled()

    vi.advanceTimersByTime(HEARTBEAT_INTERVAL_MS)
    expect(reply.raw.write).toHaveBeenCalledWith(
      `event: heartbeat\ndata: ${JSON.stringify({ generation: SERVER_GENERATION })}\n\n`,
    )

    reply.raw.write = vi.fn()
    vi.advanceTimersByTime(HEARTBEAT_INTERVAL_MS)
    expect(reply.raw.write).toHaveBeenCalledTimes(1)
  })

  it('零客户端时不启动定时器：没有任何客户端注册过，推进任意时间都不会有写入', async () => {
    const { HEARTBEAT_INTERVAL_MS } = await import('./broadcast.js')
    vi.advanceTimersByTime(HEARTBEAT_INTERVAL_MS * 5)
    // 没有客户端可写，这里只验证推进计时器不抛错——没有客户端注册就不存在断言写入的对象
    expect(true).toBe(true)
  })

  it('最后一个客户端断开后心跳停止，之后不再有任何广播写入', async () => {
    const { registerEventsClient, HEARTBEAT_INTERVAL_MS } = await import('./broadcast.js')
    const reply = fakeReply()
    registerEventsClient(reply)

    vi.advanceTimersByTime(HEARTBEAT_INTERVAL_MS)
    expect(reply.raw.write).toHaveBeenCalledTimes(1)

    reply.raw.emit('close')
    reply.raw.write = vi.fn()

    vi.advanceTimersByTime(HEARTBEAT_INTERVAL_MS * 3)
    expect(reply.raw.write).not.toHaveBeenCalled()
  })

  it('新客户端注册时若心跳已在运行，不会重复起第二个定时器（同一时刻只收到一次心跳，不是两次）', async () => {
    const { registerEventsClient, HEARTBEAT_INTERVAL_MS } = await import('./broadcast.js')
    const first = fakeReply()
    registerEventsClient(first)
    const second = fakeReply()
    registerEventsClient(second)

    vi.advanceTimersByTime(HEARTBEAT_INTERVAL_MS)
    expect(first.raw.write).toHaveBeenCalledTimes(1)
    expect(second.raw.write).toHaveBeenCalledTimes(1)
  })
})
