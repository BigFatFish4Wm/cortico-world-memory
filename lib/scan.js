/**
 * 工作区扫描：把 `*.md` 增量灌进索引。
 *
 * 增量的判据是「mtime 或 size 变了」→ 重读 → 算 sha1 → 只有 hash 也变了才重切。
 * 于是 `git checkout`、编辑器重排 mtime、agent 改完又改回去这些情况都不会白重建。
 *
 * 扫描是异步的（读文件走 fs/promises），但每篇笔记的处理是同步小事务，不会
 * 攒出一个巨大的写事务把 UI 卡住。
 *
 * 兜底：工作区不存在、单个文件读不出来、超过 maxFileBytes 都只是跳过并记一笔，
 * 不抛错——索引永远不该让对话停下来。
 */

import { createHash } from 'node:crypto'
import { readdir, readFile, stat } from 'node:fs/promises'
import { join } from 'node:path'
import { chunkDocument } from './chunk.js'
import { applySupersedes, parseDocument } from './frontmatter.js'
import { normalizePath } from './text.js'

/** 默认跳过的目录：二进制、git 内部、日志流水，索引它们只浪费预算。 */
export const DEFAULT_SKIP_DIRS = ['.git', '.index', 'node_modules', 'blobs', 'log', 'data', 'archive', 'tmp', '.trash']

/** 认作笔记的扩展名。 */
const NOTE_EXT = /\.(md|markdown)$/i

/**
 * 递归列出工作区里的笔记（相对路径 + 大小 + mtime）。
 *
 * 返回 [{ path, abs, size, mtime }]，path 是相对工作区、正斜杠、无 `./` 前缀。
 */
export async function walkNotes(root, { skipDirs = DEFAULT_SKIP_DIRS, maxFileBytes = 2 * 1024 * 1024 } = {}) {
  const skip = new Set(skipDirs.map((name) => name.toLowerCase()))
  const out = []
  const stack = ['']
  while (stack.length) {
    const relative = stack.pop()
    const absolute = relative ? join(root, relative) : root
    let entries
    try {
      entries = await readdir(absolute, { withFileTypes: true })
    } catch {
      continue
    }
    for (const entry of entries) {
      const childRelative = relative ? `${relative}/${entry.name}` : entry.name
      if (entry.isDirectory()) {
        if (skip.has(entry.name.toLowerCase())) continue
        // 点开头的一律不进索引（.git、.obsidian、.index …）。
        if (entry.name.startsWith('.')) continue
        stack.push(childRelative)
        continue
      }
      if (!entry.isFile()) continue
      if (!NOTE_EXT.test(entry.name)) continue
      const childAbsolute = join(root, childRelative)
      let info
      try {
        info = await stat(childAbsolute)
      } catch {
        continue
      }
      if (info.size > maxFileBytes) continue
      out.push({
        path: normalizePath(childRelative),
        abs: childAbsolute,
        size: info.size,
        mtime: Math.floor(info.mtimeMs),
      })
    }
  }
  out.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0))
  return out
}

/** 文件的 sha1（前 16 位十六进制）。 */
export async function hashFile(abs) {
  const buffer = await readFile(abs)
  return createHash('sha1').update(buffer).digest('hex').slice(0, 16)
}

/**
 * 增量同步。
 *
 * opts:
 *   store           openStore 的返回值
 *   workspace       绝对路径
 *   skipDirs/maxFileBytes  透传 walkNotes
 *   embed           (text) => Float32Array | null，给了就顺带算向量
 *   deadline        Date.now() 时间戳；超时就提前收工（下次再补），避免拖死前缀构建
 *   onProgress      (event) => void，诊断用
 *
 * 返回 { added, updated, removed, unchanged, skipped, docs, chunks, ms, truncated }
 */
export async function syncIndex({
  store,
  workspace,
  skipDirs = DEFAULT_SKIP_DIRS,
  maxFileBytes = 2 * 1024 * 1024,
  embed = null,
  deadline = Infinity,
  onProgress = null,
} = {}) {
  const started = Date.now()
  const result = { added: 0, updated: 0, removed: 0, unchanged: 0, skipped: 0, docs: 0, chunks: 0, ms: 0, truncated: false }
  const files = await walkNotes(workspace, { skipDirs, maxFileBytes })
  const known = store.listDocs()
  const seen = new Set()
  const parsed = []

  for (const file of files) {
    if (Date.now() > deadline) {
      result.truncated = true
      break
    }
    seen.add(file.path)
    const previous = known.get(file.path)
    const fresh = !previous
      || previous.mtime !== file.mtime
      || previous.size !== file.size

    if (!fresh) {
      result.unchanged += 1
      continue
    }

    let raw
    try {
      raw = await readFile(file.abs, 'utf8')
    } catch {
      result.skipped += 1
      continue
    }
    const hash = createHash('sha1').update(raw).digest('hex').slice(0, 16)
    if (previous && previous.hash === hash) {
      // 只有 mtime 变了：内容一样，连状态都不用重算。
      result.unchanged += 1
      continue
    }

    const doc = parseDocument(file.path, raw, { mtime: file.mtime })
    if (!doc.statusValid) {
      doc.note = `status "${doc.declaredStatus}" 不认识，按 active 处理（认：active / unfinished / superseded / archived）`
    }
    doc.mtime = file.mtime
    doc.size = file.size
    doc.hash = hash
    parsed.push({ doc, raw })
  }

  // supersede 传播要看到全量状态，所以先写文件、再统一算状态。
  for (const { doc, raw } of parsed) {
    const chunks = chunkDocument(doc.body, { title: doc.title })
    const vectors = embed
      ? await Promise.all(chunks.map((chunk) => embed(`${doc.title}\n${chunk.body}`)))
      : null
    try {
      store.upsertDoc(doc, chunks, vectors)
      result.chunks += chunks.length
      result.docs += 1
      if (known.has(doc.path)) result.updated += 1
      else result.added += 1
      onProgress?.({ kind: 'indexed', path: doc.path, chunks: chunks.length, chars: raw.length })
    } catch (error) {
      result.skipped += 1
      onProgress?.({ kind: 'failed', path: doc.path, error: error instanceof Error ? error.message : String(error) })
    }
  }

  for (const path of known.keys()) {
    if (seen.has(path)) continue
    try {
      store.deleteDoc(path)
      result.removed += 1
    } catch {
      // 删不掉就留着，下次再试。
    }
  }

  // 第二趟：谁推翻了谁。只改状态，不动段。
  try {
    const docs = store.allDocs()
    const effective = docs.map((doc) => ({
      path: doc.path,
      status: doc.declaredStatus || 'active',
      effectiveStatus: doc.declaredStatus || 'active',
      supersedes: doc.supersedes ?? [],
      supersededBy: doc.supersededBy ?? [],
    }))
    const changed = applySupersedes(effective)
    // 文件被删掉时，它推翻过的旧条目要能重新生效，所以 removed 也算一次变动。
    if (changed > 0 || parsed.length > 0 || result.removed > 0) {
      for (const doc of effective) {
        const before = docs.find((item) => item.path === doc.path)
        if (!before) continue
        if (before.status !== doc.effectiveStatus) {
          store.setStatus(doc.path, doc.effectiveStatus, doc.supersededBy)
        } else if (doc.supersededBy.length && before.supersededBy.length !== doc.supersededBy.length) {
          store.setStatus(doc.path, doc.effectiveStatus, doc.supersededBy)
        }
      }
    }
  } catch (error) {
    onProgress?.({ kind: 'supersede-failed', error: error instanceof Error ? error.message : String(error) })
  }

  const stats = store.stats()
  result.docs = stats.docs
  result.chunks = stats.chunks
  result.ms = Date.now() - started
  try {
    store.setMeta('scanned_at', String(Date.now()))
    store.pruneRefs(Date.now() - 90 * 86_400_000)
  } catch {
    // 元信息写不进去不影响这次结果。
  }
  return result
}
