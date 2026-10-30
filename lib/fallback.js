/**
 * 兜底：索引不可用（没有 node:sqlite、库损坏、目录写不了）时的检索。
 *
 * spec 的要求是「静默退回现有 grep_files 行为，不要报错打断对话」。这里做的就是
 * 那件事的本机版：直接扫工作区里的 markdown，按命中的二元组算分，给回同样的
 * { path, title, snippet, score } 形状，上层代码不用分叉。
 */

import { readFile } from 'node:fs/promises'
import { matchSupersede, parseDocument } from './frontmatter.js'
import { DEFAULT_SKIP_DIRS, walkNotes } from './scan.js'
import { coverageTerms, estimateTokens, oneLine, snippet } from './text.js'

/**
 * 扫文件找相关段落。
 *
 * 一次读一个文件，命中词越多越靠前；只读前 maxFiles 个候选（默认全读，
 * 工作区几千个文件也就几 MB）。返回结果形状与 search.js 保持一致。
 */
export async function grepNotes({
  workspace,
  query,
  k = 5,
  maxAgeDays = 0,
  pathPrefix = '',
  skipDirs = DEFAULT_SKIP_DIRS,
  maxFileBytes = 2 * 1024 * 1024,
  budgetTokens = 2000,
  now = Date.now(),
} = {}) {
  const terms = coverageTerms(query)
  if (!terms.length) return []
  const files = await walkNotes(workspace, { skipDirs, maxFileBytes })
  const cutoff = maxAgeDays > 0 ? now - maxAgeDays * 86_400_000 : 0
  const docs = []

  for (const file of files) {
    if (pathPrefix && !file.path.startsWith(pathPrefix) && !file.path.includes(pathPrefix)) continue
    if (cutoff && file.mtime < cutoff) continue
    let raw
    try {
      raw = await readFile(file.abs, 'utf8')
    } catch {
      continue
    }
    const doc = parseDocument(file.path, raw, { mtime: file.mtime })
    let hit = 0
    let haystack = `${doc.title}\n${doc.body}`.toLowerCase()
    for (const term of terms) {
      if (haystack.includes(term.toLowerCase())) hit += 1
    }
    if (!hit) continue
    docs.push({ doc, coverage: hit / terms.length, mtime: file.mtime })
    haystack = ''
  }

  // 被推翻的条目一样不返回：兜底不代表可以返回过期事实。
  const known = new Set(docs.map((item) => item.doc.path))
  const superseded = new Set()
  for (const item of docs) {
    for (const target of item.doc.supersedes) {
      const hit = matchSupersede(target, known)
      if (hit) superseded.add(hit)
    }
  }

  docs.sort((a, b) => b.coverage - a.coverage || b.mtime - a.mtime)
  const out = []
  let used = 0
  for (const item of docs) {
    if (out.length >= k) break
    if (item.doc.status === 'superseded' || item.doc.status === 'archived') continue
    if (superseded.has(item.doc.path)) continue
    const text = oneLine(snippet(item.doc.body, [...terms, query], { radius: 80 }))
    const cost = estimateTokens(`- [[${item.doc.path}]] ${text}`)
    if (out.length > 0 && used + cost > budgetTokens) break
    used += cost
    out.push({
      path: item.doc.path,
      title: item.doc.title,
      snippet: text,
      score: Number(item.coverage.toFixed(3)),
      coverage: Number(item.coverage.toFixed(3)),
      cited: 0,
      status: item.doc.status,
      updated: item.doc.updatedAt ? new Date(item.doc.updatedAt).getTime() : item.mtime,
      chunks: [],
      tokens: cost,
    })
  }
  return out
}
