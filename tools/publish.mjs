#!/usr/bin/env node
/**
 * 发布到 GitHub（走 REST API，不依赖 git push——有的机器 443 到 github.com 的 git 通道被拦）。
 *
 * 用法：
 *   node tools/publish.mjs [--tag v1.0.0] [--dry]
 *
 * 行为：
 *  1. 读 token：GITHUB_TOKEN，或 %USERPROFILE%\.pwa\github-token.txt；
 *  2. 仓库不存在就创建（公开），描述取 package.json；
 *  3. 用 Git Data API 建 blobs/tree/commit 更新 main（有历史就挂父提交）；
 *  4. 建/更新 release，说明取 CHANGELOG.md 里 `<tag>` 那一段，上传 release/*.zip；
 *  5. 打印地址。
 *
 * 不发布：node_modules、release（zip 走 release 资产）、.index、临时文件。
 */
import { execFileSync } from 'node:child_process'
import { existsSync, readFileSync, readdirSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { homedir } from 'node:os'

const args = process.argv.slice(2)
const arg = (name, fallback) => {
  const i = args.indexOf(name)
  return i >= 0 && args[i + 1] ? args[i + 1] : fallback
}
const ROOT = resolve(import.meta.dirname, '..')
const pkg = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8'))
const REPO = arg('--repo', pkg.name)
const TAG = arg('--tag', `v${pkg.version}`)
const BRANCH = arg('--branch', 'main')
const DRY = args.includes('--dry')
const API = 'https://api.github.com'
const MESSAGE = arg('--message', `${pkg.name} ${TAG}`)

function readToken() {
  if (process.env.GITHUB_TOKEN) return process.env.GITHUB_TOKEN.trim()
  for (const file of [join(homedir(), '.pwa', 'github-token.txt'), join(homedir(), '.config', 'pwa', 'github-token.txt')]) {
    if (existsSync(file)) return readFileSync(file, 'utf8').trim()
  }
  console.error('找不到 token：设 GITHUB_TOKEN，或写到 %USERPROFILE%\\.pwa\\github-token.txt')
  process.exit(1)
}
const TOKEN = readToken()

async function api(path, options = {}) {
  const response = await fetch(`${API}${path}`, {
    ...options,
    headers: {
      Authorization: `Bearer ${TOKEN}`,
      Accept: 'application/vnd.github+json',
      'User-Agent': pkg.name,
      'X-GitHub-Api-Version': '2022-11-28',
      ...(options.headers ?? {}),
    },
  })
  const text = await response.text()
  let body = null
  try { body = text ? JSON.parse(text) : null } catch { body = text }
  if (!response.ok) {
    const error = new Error(`${options.method ?? 'GET'} ${path} -> ${response.status}: ${body?.message ?? response.statusText}`)
    error.status = response.status
    error.body = body
    throw error
  }
  return body
}

const GIT_BIN = process.env.GIT_BIN
  || (existsSync('D:\\Program Files\\coopanion\\resources\\app\\mingit\\cmd\\git.exe')
    ? 'D:\\Program Files\\coopanion\\resources\\app\\mingit\\cmd\\git.exe'
    : 'git')

/** 要发布的文件：优先用 git ls-files（尊重 .gitignore），没有 git 就扫目录。 */
async function listFiles() {
  try {
    return execFileSync(GIT_BIN, ['-c', 'core.quotepath=false', 'ls-files'], { cwd: ROOT, encoding: 'utf8' })
      .split(/\r?\n/)
      .filter(Boolean)
      .filter((path) => existsSync(join(ROOT, path)))
  } catch {
    console.warn('[publish] 没有 git，退回扫目录')
    const { walk } = await import('./zip.mjs')
    return walk(ROOT)
  }
}

/** release 说明：CHANGELOG.md 里 tag 对应的那段（`## 1.0.0` 或 `## [1.0.0] - 日期`）。 */
function releaseNotes() {
  const path = join(ROOT, 'CHANGELOG.md')
  if (!existsSync(path)) return `${pkg.name} ${TAG}`
  const version = TAG.replace(/^v/i, '')
  const lines = readFileSync(path, 'utf8').replace(/\r\n/g, '\n').split('\n')
  const start = lines.findIndex((line) => /^##\s+/.test(line) && line.includes(version))
  if (start < 0) return `${pkg.name} ${TAG}`
  const out = []
  for (let i = start + 1; i < lines.length; i += 1) {
    if (/^##\s+/.test(lines[i])) break
    out.push(lines[i])
  }
  return `${lines[start].replace(/^##\s+/, '## ')}\n${out.join('\n').trim()}\n`
}

async function main() {
  const me = await api('/user')
  const owner = me.login
  console.log(`[publish] owner=${owner} repo=${REPO}`)

  // --dry 只列出要发什么，不建仓库、不写任何东西。
  const files = await listFiles()
  console.log(`[publish] 文件数 ${files.length}${DRY ? '（dry run，不会写远端）' : ''}`)
  if (DRY) {
    for (const path of files) console.log('  ' + path)
    return
  }

  let repo
  try {
    repo = await api(`/repos/${owner}/${REPO}`)
    console.log(`[publish] 仓库已存在：${repo.html_url}`)
  } catch (error) {
    if (error.status !== 404) throw error
    repo = await api('/user/repos', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        name: REPO,
        description: pkg.description,
        private: false,
        has_issues: true,
        has_wiki: false,
        auto_init: false,
      }),
    })
    console.log(`[publish] 仓库已创建：${repo.html_url}`)
  }

  let parentSha = null
  try {
    const ref = await api(`/repos/${owner}/${REPO}/git/ref/heads/${BRANCH}`)
    parentSha = ref.object.sha
  } catch (error) {
    if (error.status !== 404 && error.status !== 409) throw error
  }

  // 空仓库不能直接用 Git Data API：先用 Contents API 建一个初始提交。
  if (!parentSha) {
    try {
      await api(`/repos/${owner}/${REPO}/contents/README.md`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          message: 'chore: init repository',
          content: Buffer.from('# 初始化中\n').toString('base64'),
          branch: BRANCH,
        }),
      })
    } catch (error) {
      if (error.status !== 422) throw error
    }
    parentSha = (await api(`/repos/${owner}/${REPO}/git/ref/heads/${BRANCH}`)).object.sha
  }

  const tree = []
  for (const path of files) {
    const content = readFileSync(join(ROOT, path))
    const blob = await api(`/repos/${owner}/${REPO}/git/blobs`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ content: content.toString('base64'), encoding: 'base64' }),
    })
    tree.push({ path, mode: '100644', type: 'blob', sha: blob.sha })
  }
  const treeResult = await api(`/repos/${owner}/${REPO}/git/trees`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ tree }),
  })
  const commit = await api(`/repos/${owner}/${REPO}/git/commits`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ message: MESSAGE, tree: treeResult.sha, parents: parentSha ? [parentSha] : [] }),
  })
  console.log(`[publish] commit ${commit.sha}`)

  if (parentSha) {
    await api(`/repos/${owner}/${REPO}/git/refs/heads/${BRANCH}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ sha: commit.sha, force: true }),
    })
  } else {
    await api(`/repos/${owner}/${REPO}/git/refs`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ ref: `refs/heads/${BRANCH}`, sha: commit.sha }),
    })
  }
  await api(`/repos/${owner}/${REPO}`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ default_branch: BRANCH }),
  }).catch(() => {})

  const body = releaseNotes()
  let release
  try {
    release = await api(`/repos/${owner}/${REPO}/releases/tags/${TAG}`)
    release = await api(`/repos/${owner}/${REPO}/releases/${release.id}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ body }),
    })
    console.log(`[publish] release 已更新：${release.html_url}`)
  } catch (error) {
    if (error.status !== 404) throw error
    release = await api(`/repos/${owner}/${REPO}/releases`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        tag_name: TAG,
        target_commitish: commit.sha,
        name: `${pkg.name} ${TAG}`,
        body,
        draft: false,
        prerelease: false,
      }),
    })
    console.log(`[publish] release 已创建：${release.html_url}`)
  }

  const releaseDir = join(ROOT, 'release')
  const assets = new Map((release.assets ?? []).map((asset) => [asset.name, asset]))
  if (existsSync(releaseDir)) {
    for (const name of readdirSync(releaseDir).filter((item) => item.endsWith('.zip'))) {
      const data = readFileSync(join(releaseDir, name))
      // 同名资产内容变了（大小不同）就先删掉再传，否则 release 上会一直是旧包。
      const existing = assets.get(name)
      if (existing && existing.size === data.length) {
        console.log(`[publish] 资产未变，跳过 ${name}`)
        continue
      }
      if (existing) {
        await api(`/repos/${owner}/${REPO}/releases/assets/${existing.id}`, { method: 'DELETE' })
        console.log(`[publish] 旧资产已删除 ${name}`)
      }
      const uploaded = await fetch(
        `https://uploads.github.com/repos/${owner}/${REPO}/releases/${release.id}/assets?name=${encodeURIComponent(name)}`,
        {
          method: 'POST',
          headers: {
            Authorization: `Bearer ${TOKEN}`,
            Accept: 'application/vnd.github+json',
            'User-Agent': pkg.name,
            'Content-Type': 'application/octet-stream',
            'Content-Length': String(data.length),
          },
          body: data,
        },
      )
      if (!uploaded.ok) console.error(`[publish] 资产上传失败 ${name}: ${uploaded.status} ${await uploaded.text()}`)
      else console.log(`[publish] 资产已上传 ${name} (${data.length} bytes)`)
    }
  }

  console.log(`[publish] 完成：${repo.html_url}`)
  console.log(`[publish] release：${release.html_url}`)
}

main().catch((error) => {
  console.error('[publish] 失败:', error.message)
  if (error.body) console.error(JSON.stringify(error.body).slice(0, 500))
  process.exit(1)
})
