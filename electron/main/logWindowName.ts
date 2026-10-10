// electron/main/logWindowName.ts — 按窗口当前页面 URL 的 pathname 末尾判断它是 overlay / settings / chat，作为渲染进程日志的来源名
// 用法：index.ts 的 console-message 处理里调 windowNameFromUrl(win.webContents.getURL())，结果传给 appendLogLine 的 source
// 对应文件：electron/main/index.ts / shared/logFile.ts（appendLogLine）/ electron/main/logWindowName.test.ts
export type LogWindowName = 'overlay' | 'settings' | 'chat'

export function windowNameFromUrl(url: string): LogWindowName {
  try {
    const pathname = new URL(url).pathname
    if (pathname.endsWith('/overlay/index.html')) return 'overlay'
    if (pathname.endsWith('/settings/index.html')) return 'settings'
  } catch {}
  return 'chat'
}
