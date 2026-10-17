// electron/main/autostart.ts — 开机自启的登录项参数与 --autostart 启动参数判断
// 用法：index.ts 用 loginItemOptions(process.execPath, app.getAppPath()) 构造 app.getLoginItemSettings / setLoginItemSettings 的 path 与 args，用 hasAutostartFlag(process.argv) 判断本次启动是否带 --autostart
// 对应文件：electron/main/index.ts / electron/main/autostart.test.ts

export const AUTOSTART_FLAG = '--autostart'

export function loginItemOptions(execPath: string, appPath: string): { path: string; args: string[] } {
  return { path: execPath, args: [`"${appPath}"`, AUTOSTART_FLAG] }
}

export function hasAutostartFlag(argv: readonly string[]): boolean {
  return argv.includes(AUTOSTART_FLAG)
}
