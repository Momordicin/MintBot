import { describe, it, expect, beforeEach } from 'vitest'
import Fastify from 'fastify'
import fs from 'fs'
import { userProfileRoutes } from './userProfile.js'
import { USER_PROFILE_PATH, setLocation } from '../profile/userProfile.js'

beforeEach(() => {
  fs.rmSync(USER_PROFILE_PATH, { force: true })
})

describe('GET /user-profile', () => {
  it('没有记录时 location 为 null', async () => {
    const fastify = Fastify()
    await fastify.register(userProfileRoutes)

    const response = await fastify.inject({ method: 'GET', url: '/user-profile' })

    expect(response.statusCode).toBe(200)
    expect(response.json()).toEqual({ location: null })
  })

  it('有记录时返回 value、userInput、recordedAt', async () => {
    setLocation({ value: '中国上海市徐汇区', userInput: '徐汇' })
    const fastify = Fastify()
    await fastify.register(userProfileRoutes)

    const response = await fastify.inject({ method: 'GET', url: '/user-profile' })

    const body = response.json()
    expect(body.location.value).toBe('中国上海市徐汇区')
    expect(body.location.userInput).toBe('徐汇')
    expect(typeof body.location.recordedAt).toBe('string')
  })
})
