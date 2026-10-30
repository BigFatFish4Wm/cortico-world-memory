#!/usr/bin/env node
/**
 * 打包：把扩展需要的那几个文件打成 release/cortico-world-memory-<version>.zip。
 *
 * 解压得到 `cortico-world-memory/...`，和 Coopanion 扩展市场的包结构一致
 * （package.json 的 `files` 列了什么就打什么，外加 README/CHANGELOG/LICENSE）。
 *
 * 用法：node tools/pack.mjs
 */
import { mkdirSync, writeFileSync, readFileSync, existsSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { zipDirectory } from './zip.mjs'

const ROOT = resolve(import.meta.dirname, '..')
const pkg = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8'))
const name = pkg.name
const version = pkg.version

// 先摆一个干净的 staging 目录，只放该发布的文件。
const staging = join(ROOT, 'release', '.staging', name)
mkdirSync(staging, { recursive: true })

const { cpSync } = await import('node:fs')
// package.json 总要带上；其余按 package.json 的 files。
const include = ['package.json', ...(pkg.files ?? []), 'LICENSE']
for (const entry of new Set(include)) {
  const from = join(ROOT, entry)
  if (!existsSync(from)) {
    console.warn(`[pack] 跳过不存在的 ${entry}`)
    continue
  }
  cpSync(from, join(staging, entry), { recursive: true })
}

// staging 里已经有一层 `cortico-world-memory/`，别再套一层。
const buffer = zipDirectory(join(ROOT, 'release', '.staging'), { skip: [/^\./] })
const out = join(ROOT, 'release', `${name}-${version}.zip`)
writeFileSync(out, buffer)
console.log(`[pack] ${out} (${buffer.length} bytes)`)

const { rmSync } = await import('node:fs')
rmSync(join(ROOT, 'release', '.staging'), { recursive: true, force: true })
