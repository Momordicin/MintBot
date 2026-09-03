import { describe, it, expect, vi } from 'vitest'
import { EventEmitter } from 'events'
import type { FastifyReply } from 'fastify'
import { registerEventsClient, broadcastEvent } from './broadcast.js'

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
})
