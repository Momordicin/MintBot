// 初始化 services/core/db/vendor/libsimple-<platform>/（动态库 + jieba 词典），
// 从 wangfenjin/simple 的 GitHub Release 下载并解压，避免把这份预编译二进制 + 词典
// （~16MB）提交进仓库。运行方式：pnpm setup:vendor（首次 clone 后 / CI 里跑一次）。
// 已存在且非 --force 时直接跳过，方便重复执行。目前支持 Windows / macOS（见下方
// getPlatformTarget()）。

import { execFileSync } from 'child_process'
import fs from 'fs'
import os from 'os'
import path from 'path'

const SIMPLE_VERSION = 'v0.7.1'

const VENDOR_DIR = path.resolve(process.cwd(), 'services/core/db/vendor')

// 跟 services/core/db/index.ts 里 initDb() 加载扩展时用的映射表一一对应，两处各自
// 独立维护（映射表足够小，不值得为了避免重复引入跨文件依赖），改动时两处都要看一眼
function getPlatformTarget(): { assetName: string; dirName: string; libFileName: string } {
  if (process.platform === 'win32') {
    return { assetName: 'libsimple-windows-x64.zip', dirName: 'libsimple-windows-x64', libFileName: 'simple.dll' }
  }
  if (process.platform === 'darwin') {
    const arch = process.arch === 'arm64' ? 'arm64' : 'x64'
    return { assetName: `libsimple-osx-${arch}.zip`, dirName: `libsimple-osx-${arch}`, libFileName: 'libsimple.dylib' }
  }
  throw new Error(`setup-vendor 目前只支持 Windows / macOS，当前平台是 ${process.platform}，暂不支持`)
}

// Windows 10/Server 2019 起自带的 bsdtar，支持直接解压 .zip；PATH 上可能同时存在
// Git for Windows 自带的 GNU tar（不认 zip 格式），所以显式指向 System32 版本
const SYSTEM_TAR = path.join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'tar.exe')

async function download(url: string, destFile: string): Promise<void> {
  const res = await fetch(url)
  if (!res.ok) {
    throw new Error(`下载失败：${url}（HTTP ${res.status}）`)
  }
  const buffer = Buffer.from(await res.arrayBuffer())
  fs.writeFileSync(destFile, buffer)
}

async function main() {
  const { assetName, dirName, libFileName } = getPlatformTarget()
  const RELEASE_URL = `https://github.com/wangfenjin/simple/releases/download/${SIMPLE_VERSION}/${assetName}`
  const TARGET_DIR = path.join(VENDOR_DIR, dirName)
  const LIB_PATH = path.join(TARGET_DIR, libFileName)

  const force = process.argv.includes('--force')
  if (fs.existsSync(LIB_PATH) && !force) {
    console.log(`[setup-vendor] 已存在 ${LIB_PATH}，跳过（如需重新下载加 --force）`)
    return
  }

  fs.mkdirSync(VENDOR_DIR, { recursive: true })
  const tmpZip = path.join(os.tmpdir(), `${assetName}.${process.pid}`)

  console.log(`[setup-vendor] 下载 ${RELEASE_URL}`)
  await download(RELEASE_URL, tmpZip)

  console.log(`[setup-vendor] 解压到 ${VENDOR_DIR}`)
  try {
    if (process.platform === 'win32') {
      execFileSync(SYSTEM_TAR, ['-xf', tmpZip, '-C', VENDOR_DIR])
    } else {
      // macOS 自带 bsdtar，PATH 上直接就是能解压 zip 的版本，不需要像 Windows 那样
      // 显式指向系统目录规避 Git for Windows 的 GNU tar
      execFileSync('tar', ['-xf', tmpZip, '-C', VENDOR_DIR])
    }
  } catch (err) {
    fs.rmSync(tmpZip, { force: true })
    throw new Error(
      `解压失败，如果 ${libFileName} 正被运行中的服务占用（已加载的动态库会被独占锁定），请先停掉本地 core 服务再重试。原始错误：${err}`
    )
  }
  fs.rmSync(tmpZip, { force: true })

  if (!fs.existsSync(LIB_PATH)) {
    throw new Error(`解压完成但未找到 ${LIB_PATH}，release 包结构可能变了`)
  }

  if (process.platform === 'darwin') {
    // 未签名的 .dylib 首次加载可能被 Gatekeeper 的 quarantine 属性拦截（wangfenjin/simple
    // GitHub issue #138），主动清除；属性本来就不存在时 xattr -d 会非零退出，忽略即可
    try {
      execFileSync('xattr', ['-d', 'com.apple.quarantine', LIB_PATH])
    } catch {
      // 属性不存在或 xattr 不可用，不是错误
    }
  }

  console.log(`[setup-vendor] 完成：${LIB_PATH}`)
}

main().catch(err => {
  console.error('[setup-vendor] failed:', err)
  process.exit(1)
})
