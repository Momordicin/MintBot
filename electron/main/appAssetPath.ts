// electron/main/appAssetPath.ts — 把 app://mintbot/<path> 请求 URL 映射为渲染目录内的文件绝对路径，越界或非本来源返回 null
// 用法：index.ts 的 protocol.handle('app') 调 resolveAppAssetPath(rendererRoot, request.url)
// 对应文件：electron/main/index.ts / electron/main/appOrigin.ts
import { isAbsolute, relative, resolve } from 'path'
import { APP_ORIGIN } from './appOrigin'

export function resolveAppAssetPath(rendererRoot: string, requestUrl: string): string | null {
  let url: URL
  try {
    url = new URL(requestUrl)
  } catch {
    return null
  }
  if (`${url.protocol}//${url.host}` !== APP_ORIGIN) return null
  let decoded: string
  try {
    decoded = decodeURIComponent(url.pathname)
  } catch {
    return null
  }
  if (decoded.includes('\0')) return null
  const target = resolve(rendererRoot, '.' + (decoded.endsWith('/') ? decoded + 'index.html' : decoded))
  const rel = relative(rendererRoot, target)
  if (rel === '' || rel.startsWith('..') || isAbsolute(rel)) return null
  return target
}
