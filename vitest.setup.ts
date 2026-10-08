import * as dotenv from 'dotenv'
import fs from 'fs'
import os from 'os'
import path from 'path'
import { afterAll } from 'vitest'

dotenv.config({ path: '.env.test', quiet: true, override: true })

const testRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'mintbot-vitest-'))
process.env.ASSET_PATH = path.join(testRoot, 'assets')
process.env.WALLPAPER_PATH = path.join(testRoot, 'wallpapers')
fs.mkdirSync(path.join(testRoot, 'assets', 'characters'), { recursive: true })
fs.mkdirSync(path.join(testRoot, 'wallpapers'), { recursive: true })

const exampleManifest = path.resolve(process.cwd(), 'assets', 'characters', 'example', 'manifest.json')
if (fs.existsSync(exampleManifest)) {
  const exampleDir = path.join(testRoot, 'assets', 'characters', 'example')
  fs.mkdirSync(exampleDir, { recursive: true })
  fs.copyFileSync(exampleManifest, path.join(exampleDir, 'manifest.json'))
}

afterAll(() => fs.rmSync(testRoot, { recursive: true, force: true }))
