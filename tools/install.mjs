#!/usr/bin/env node
/**
 * 装进本机 Coopanion：建 node_modules 里的链接，并在部署配置里启用。
 * 只改文件，不重启进程（World 是 ESM 模块，加载后不热更）。
 *
 * 用法：
 *   node tools/install.mjs                 # 装 + 启用
 *   node tools/install.mjs --disable       # 只关掉 worlds.memory.enabled
 *   node tools/install.mjs --coopanion "D:\Program Files\coopanion"
 *   node tools/install.mjs --workspace "D:\我的笔记"   # 索引别的目录
 *
 * 任何一步失败都会打印清楚的手工步骤——不会半装半不装。
 */
import { existsSync, lstatSync, readFileSync, unlinkSync, writeFileSync, mkdirSync } from 'node:fs'
import { join, resolve } from 'node:path'

const args = process.argv.slice(2)
const arg = (name, fallback) => {
  const i = args.indexOf(name)
  return i >= 0 && args[i + 1] ? args[i + 1] : fallback
}
const ROOT = resolve(import.meta.dirname, '..')
const pkg = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8'))
const COOPANION = resolve(arg('--coopanion', process.env.COOPANION_DIR || 'D:\\Program Files\\coopanion'))
const DISABLE = args.includes('--disable')
const WORKSPACE = arg('--workspace', '')
const NAME = pkg.name

const extensions = join(COOPANION, 'data', 'extensions')
const link = join(extensions, 'node_modules', NAME)
const config = join(COOPANION, 'data', 'home', 'companion', 'config.json')

function readJson(path) {
  return JSON.parse(readFileSync(path, 'utf8').replace(/^\uFEFF/, ''))
}

function writeJson(path, value) {
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`, 'utf8')
}

if (!existsSync(extensions)) {
  console.error(`找不到 Coopanion 扩展目录：${extensions}`)
  console.error('用 --coopanion 指定安装目录，或先在 Coopanion 里装任意一个扩展。')
  process.exit(1)
}

// ---- 1. 链接（junction，Windows 上不需要管理员权限）
if (!DISABLE) {
  mkdirSync(join(extensions, 'node_modules'), { recursive: true })
  if (existsSync(link) || isLink(link)) {
    try {
      unlinkSync(link)
    } catch {
      console.error(`已有 ${link}，但删不掉（可能是真实目录）。请手工处理后再试。`)
      process.exit(1)
    }
  }
  try {
    const { symlinkSync } = await import('node:fs')
    symlinkSync(ROOT, link, 'junction')
    console.log(`[install] 链接：${link} -> ${ROOT}`)
  } catch (error) {
    console.error(`[install] 建链接失败：${error.message}`)
    console.error(`  手工步骤：mklink /J "${link}" "${ROOT}"`)
    process.exit(1)
  }

  // ---- 2. 在 extensions/package.json 里登记（pnpm link: 依赖）
  const pkgPath = join(extensions, 'package.json')
  if (existsSync(pkgPath)) {
    const manifest = readJson(pkgPath)
    manifest.dependencies ??= {}
    manifest.dependencies[NAME] = `link:${ROOT}`
    writeJson(pkgPath, manifest)
    console.log(`[install] 登记：${join(extensions, 'package.json')} → ${NAME}: link:${ROOT}`)
  }
}

function isLink(path) {
  try {
    return lstatSync(path).isSymbolicLink()
  } catch {
    return false
  }
}

// ---- 3. 部署配置
if (!existsSync(config)) {
  console.error(`找不到部署配置：${config}（Coopanion 至少启动过一次才会有）`)
  process.exit(1)
}
const cfg = readJson(config)
cfg.worlds ??= {}
cfg.worlds.memory = {
  ...(cfg.worlds.memory ?? {}),
  enabled: !DISABLE,
  workspace: WORKSPACE || cfg.worlds.memory?.workspace || '',
  inject: true,
  topK: 5,
  budgetTokens: 2000,
  minCoverage: 0.12,
  halfLifeDays: 90,
  refBoost: 0.3,
  vector: 'auto',
  embedModel: '',
  scanSeconds: 30,
  maxAgeDays: 0,
  queryHint: '',
  maxChars: 4000,
}
writeJson(config, cfg)
console.log(`[install] 配置：worlds.memory.enabled=${!DISABLE}${WORKSPACE ? ` · 索引 ${WORKSPACE}` : ''}`)
console.log('[install] 重启 Coopanion 才会加载；之后在「世界 → 记忆检索」里看索引状态。')
