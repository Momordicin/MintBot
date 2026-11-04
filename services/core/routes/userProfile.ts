// services/core/routes/userProfile.ts — 用户资料读取路由
// 用法：core/index.ts 里 fastify.register(userProfileRoutes)；GET /user-profile 返回 { location: { value, userInput, recordedAt } | null }
// 对应文件：services/core/profile/userProfile.ts / services/core/routes/userProfile.test.ts
import type { FastifyInstance } from 'fastify'
import { getLocation } from '../profile/userProfile.js'

export async function userProfileRoutes(fastify: FastifyInstance) {
  fastify.get('/user-profile', async () => {
    return { location: getLocation() }
  })
}
