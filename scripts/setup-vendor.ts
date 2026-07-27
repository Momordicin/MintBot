// 初始化 services/core/db/vendor/libsimple-windows-x64/（simple.dll + jieba 词典），
// 从 wangfenjin/simple 的 GitHub Release 下载并解压，避免把这份预编译二进制 + 词典
// （~16MB）提交进仓库。运行方式：pnpm setup:vendor（首次 clone 后 / CI 里跑一次）。
// 已存在且非 --force 时直接跳过，方便重复执行。

import { execFileSync } from 'child_process'
import fs from 'fs'
import os from 'os'
import path from 'path'

const SIMPLE_VERSION = 'v0.7.1'
const ASSET_NAME = 'libsimple-windows-x64.zip'
const RELEASE_URL = `https://github.com/wangfenjin/simple/releases/download/${SIMPLE_VERSION}/${ASSET_NAME}`

const VENDOR_DIR = path.resolve(process.cwd(), 'services/core/db/vendor')
const TARGET_DIR = path.join(VENDOR_DIR, 'libsimple-windows-x64')
const DLL_PATH = path.join(TARGET_DIR, 'simple.dll')

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
  if (process.platform !== 'win32') {
    throw new Error(
      `setup-vendor 目前只提供 Windows x64 版 libsimple（${ASSET_NAME}），当前平台是 ${process.platform}，暂不支持`
    )
  }

  const force = process.argv.includes('--force')
  if (fs.existsSync(DLL_PATH) && !force) {
    console.log(`[setup-vendor] 已存在 ${DLL_PATH}，跳过（如需重新下载加 --force）`)
    return
  }

  fs.mkdirSync(VENDOR_DIR, { recursive: true })
  const tmpZip = path.join(os.tmpdir(), `${ASSET_NAME}.${process.pid}`)

  console.log(`[setup-vendor] 下载 ${RELEASE_URL}`)
  await download(RELEASE_URL, tmpZip)

  console.log(`[setup-vendor] 解压到 ${VENDOR_DIR}`)
  try {
    execFileSync(SYSTEM_TAR, ['-xf', tmpZip, '-C', VENDOR_DIR])
  } catch (err) {
    fs.rmSync(tmpZip, { force: true })
    throw new Error(
      `解压失败，如果 simple.dll 正被运行中的服务占用（Windows 下已加载的 DLL 会被独占锁定），请先停掉本地 core 服务再重试。原始错误：${err}`
    )
  }
  fs.rmSync(tmpZip, { force: true })

  if (!fs.existsSync(DLL_PATH)) {
    throw new Error(`解压完成但未找到 ${DLL_PATH}，release 包结构可能变了`)
  }
  console.log(`[setup-vendor] 完成：${DLL_PATH}`)
}

main().catch(err => {
  console.error('[setup-vendor] failed:', err)
  process.exit(1)
})
