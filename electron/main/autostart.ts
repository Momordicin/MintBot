// electron/main/autostart.ts — 开机自启的登录项参数与 --autostart 启动参数判断
// 用法：index.ts 用 loginItemOptions / legacyLoginItemOptions / shouldMigrateAutostart / hasAutostartFlag 构造登录项参数、迁移旧登录项、判断 --autostart
// 对应文件：electron/main/index.ts / electron/main/autostart.test.ts

export const AUTOSTART_FLAG = '--autostart'

export function loginItemOptions(execPath: string, appPath: string): { path: string; args: string[] } {
  return { path: execPath, args: [appPath, AUTOSTART_FLAG] }
}

export function legacyLoginItemOptions(execPath: string, appPath: string): { path: string; args: string[] } {
  return { path: execPath, args: [`"${appPath}"`, AUTOSTART_FLAG] }
}

export function shouldMigrateAutostart(isDevMode: boolean, legacyOpenAtLogin: boolean): boolean {
  return !isDevMode && legacyOpenAtLogin
}

export function hasAutostartFlag(argv: readonly string[]): boolean {
  return argv.includes(AUTOSTART_FLAG)
}
