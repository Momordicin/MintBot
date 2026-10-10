// services/core/routes/transitions.test.ts — 转场链接口测试：响应形状、参数校验、不遮蔽 /characters/ 静态素材、按请求现读素材
//
// 用法：pnpm test
// 配套文件：services/core/routes/transitions.ts

import { describe, it, expect, afterEach, vi } from 'vitest'
import fs from 'fs'
import path from 'path'
import Fastify from 'fastify'
import fastifyStatic from '@fastify/static'
import { CHARACTERS_ROOT } from '../characters/manifest.js'
import { transitionRoutes } from './transitions.js'

const CHARACTER_ID = 'transitions-route-test'
const characterDir = path.join(CHARACTERS_ROOT, CHARACTER_ID)

async function buildTestApp() {
  const fastify = Fastify()
  await fastify.register(fastifyStatic, { root: CHARACTERS_ROOT, prefix: '/characters/', decorateReply: false })
  await fastify.register(transitionRoutes)
  return fastify
}

function writeCharacter(manifest: unknown, files: string[]) {
  fs.mkdirSync(characterDir, { recursive: true })
  fs.writeFileSync(path.join(characterDir, 'manifest.json'), JSON.stringify(manifest))
  for (const file of files) {
    fs.mkdirSync(path.dirname(path.join(characterDir, file)), { recursive: true })
    fs.writeFileSync(path.join(characterDir, file), 'img')
  }
}

const manifest = {
  portraits: {
    pixel: { emotions: { happy: ['gifs/h1.gif', 'gifs/h2.gif'], shy: ['gifs/s1.gif'] } },
    illustration: { emotions: { happy: ['ill.png'] } },
  },
  transitions: {
    'poke-neutral': [{ from: ['emotions.happy', 'emotions.shy'], durationMs: 1500 }],
  },
}

describe('GET /transitions/:characterId/:trigger', () => {
  afterEach(() => {
    fs.rmSync(characterDir, { recursive: true, force: true })
    vi.restoreAllMocks()
  })

  it('返回 { steps }，每步为相对路径候选与时长；默认 form=pixel', async () => {
    writeCharacter(manifest, ['gifs/h1.gif', 'gifs/h2.gif', 'gifs/s1.gif'])
    const fastify = await buildTestApp()

    const response = await fastify.inject({ method: 'GET', url: `/transitions/${CHARACTER_ID}/poke-neutral` })

    expect(response.statusCode).toBe(200)
    expect(JSON.parse(response.payload)).toEqual({
      steps: [{ files: ['gifs/h1.gif', 'gifs/h2.gif', 'gifs/s1.gif'], durationMs: 1500 }],
    })
  })

  it('form=illustration 读取插画组；非法 form 返回 400', async () => {
    writeCharacter(
      { ...manifest, transitions: { t: [{ from: 'emotions.happy', durationMs: 10 }] } },
      ['ill.png', 'gifs/h1.gif'],
    )
    const fastify = await buildTestApp()

    const ok = await fastify.inject({ method: 'GET', url: `/transitions/${CHARACTER_ID}/t?form=illustration` })
    expect(JSON.parse(ok.payload)).toEqual({ steps: [{ files: ['ill.png'], durationMs: 10 }] })

    const bad = await fastify.inject({ method: 'GET', url: `/transitions/${CHARACTER_ID}/t?form=other` })
    expect(bad.statusCode).toBe(400)
  })

  it('每次请求现读磁盘：文件被移走后立即不再返回，恢复后立即返回', async () => {
    writeCharacter(manifest, ['gifs/h1.gif'])
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    const fastify = await buildTestApp()
    const url = `/transitions/${CHARACTER_ID}/poke-neutral`

    expect(JSON.parse((await fastify.inject({ method: 'GET', url })).payload).steps[0].files).toEqual(['gifs/h1.gif'])

    fs.renameSync(path.join(characterDir, 'gifs/h1.gif'), path.join(characterDir, 'gifs/h1.moved'))
    expect(JSON.parse((await fastify.inject({ method: 'GET', url })).payload)).toEqual({ steps: [] })

    fs.renameSync(path.join(characterDir, 'gifs/h1.moved'), path.join(characterDir, 'gifs/h1.gif'))
    expect(JSON.parse((await fastify.inject({ method: 'GET', url })).payload).steps[0].files).toEqual(['gifs/h1.gif'])
  })

  it('未知角色或 manifest 不可用时返回 200 { steps: [] } 并告警', async () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const fastify = await buildTestApp()

    const response = await fastify.inject({ method: 'GET', url: '/transitions/no-such-character/poke-neutral' })

    expect(response.statusCode).toBe(200)
    expect(JSON.parse(response.payload)).toEqual({ steps: [] })
    expect(warnSpy).toHaveBeenCalled()
  })

  it('未声明的触发器返回空链', async () => {
    writeCharacter(manifest, ['gifs/h1.gif'])
    const fastify = await buildTestApp()

    const response = await fastify.inject({ method: 'GET', url: `/transitions/${CHARACTER_ID}/unknown-trigger` })

    expect(JSON.parse(response.payload)).toEqual({ steps: [] })
  })

  it('characterId 含路径穿越或 trigger 含非法字符时返回 400', async () => {
    const fastify = await buildTestApp()

    for (const url of [
      '/transitions/a%2F..%2Fb/poke-neutral',
      '/transitions/a%5Cb/poke-neutral',
      `/transitions/${CHARACTER_ID}/..%2Fx`,
      `/transitions/${CHARACTER_ID}/a.b`,
    ]) {
      const response = await fastify.inject({ method: 'GET', url })
      expect(response.statusCode, url).toBe(400)
    }
  })

  it('接口路径在 /characters/ 静态前缀之外：角色包内 transitions/ 目录下的真实素材仍由静态路由提供', async () => {
    writeCharacter(manifest, ['gifs/h1.gif', 'transitions/t1.gif'])
    const fastify = await buildTestApp()

    const staticTransition = await fastify.inject({ method: 'GET', url: `/characters/${CHARACTER_ID}/transitions/t1.gif` })
    expect(staticTransition.statusCode).toBe(200)
    expect(staticTransition.payload).toBe('img')

    const staticFile = await fastify.inject({ method: 'GET', url: `/characters/${CHARACTER_ID}/gifs/h1.gif` })
    expect(staticFile.statusCode).toBe(200)
    expect(staticFile.payload).toBe('img')

    const staticManifest = await fastify.inject({ method: 'GET', url: `/characters/${CHARACTER_ID}/manifest.json` })
    expect(staticManifest.statusCode).toBe(200)
    expect(JSON.parse(staticManifest.payload)).toHaveProperty('transitions')
  })
})
