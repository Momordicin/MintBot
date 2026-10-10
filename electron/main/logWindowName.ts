// electron/main/logWindowName.ts
// 用途：根据窗口当前页面 URL 的 pathname 末尾判断它是 overlay / settings / chat 哪个窗口，用作渲染进程日志的来源名
// 用法：electron/main/index.ts 的 console-message 处理里调用 windowNameFromUrl(win.webContents.getURL())
// 对应方：dev 为 http://localhost:<port>/overlay/index.html 等，打包后为 file:///…/renderer/overlay/index.html 等；
//   只看 pathname 末尾，安装目录里恰好有名为 settings 的目录也不会误判
export type LogWindowName = 'overlay' | 'settings' | 'chat'

export function windowNameFromUrl(url: string): LogWindowName {
  try {
    const pathname = new URL(url).pathname
    if (pathname.endsWith('/overlay/index.html')) return 'overlay'
    if (pathname.endsWith('/settings/index.html')) return 'settings'
  } catch {}
  return 'chat'
}
