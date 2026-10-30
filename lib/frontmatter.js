/**
 * 笔记的 YAML 头（frontmatter）与 `[[wikilink]]`：解析、状态、关系。
 *
 * 只用笔记里实际会写的那一小撮 YAML：`key: value`、`key: [a, b]`、`key:` 后跟
 * `- item` 列表、以及 `|` / `>` 多行块。嵌套映射按原文存字符串，不猜结构——
 * 索引不需要它，猜错反而会把 status 读坏。
 *
 * 认得的键（其余原样放进 meta，方便以后扩展）：
 *   title        显示标题（不给就取第一个 # 标题，再不给就取文件名）
 *   updated      这条事实最后一次是对的日期（也认 last_updated / date）
 *   status       active | unfinished | superseded | archived
 *   supersedes   被这条推翻的旧条目（路径或 [[链接]]，可数组）
 *   tags         自由标签，数组或逗号/空格分隔
 */

import { baseName, headingOf, normalizePath } from './text.js'

/** 认得的 status；别的值当作 active 并留一条 warning 给诊断用。 */
export const STATUSES = new Set(['active', 'unfinished', 'superseded', 'archived'])
/** 默认不参与检索的状态：被推翻的和归档的只留档。 */
export const HIDDEN_STATUSES = new Set(['superseded', 'archived'])

const FRONTMATTER_OPEN = /^---[ \t]*\r?\n/

/** 去掉成对引号与行尾注释。 */
function scalar(raw) {
  let value = String(raw ?? '').trim()
  if (!value) return ''
  const quoted = /^(['"])(.*)\1$/.exec(value)
  if (quoted) return quoted[2]
  const hash = value.indexOf(' #')
  if (hash > 0) value = value.slice(0, hash).trim()
  return value
}

/** `[a, b, 'c']` 或 `a, b` → ['a','b','c']。 */
function listValue(raw) {
  const text = String(raw ?? '').trim()
  if (!text) return []
  const inner = /^\[(.*)\]$/.exec(text)
  const body = inner ? inner[1] : text
  return body
    .split(/[,，]/)
    .map((item) => scalar(item))
    .filter(Boolean)
}

/**
 * 切出 frontmatter 与正文。
 *
 * 返回 { frontmatter: Record<string, string|string[]>, body, hasFrontmatter }。
 * 没有或没闭合的头一律当作正文（宁可多索引一段，也不要把文件读成空）。
 */
export function splitFrontmatter(raw) {
  const text = String(raw ?? '').replace(/^\uFEFF/, '')
  if (!FRONTMATTER_OPEN.test(text)) return { frontmatter: {}, body: text, hasFrontmatter: false }
  const lines = text.split('\n')
  let end = -1
  for (let i = 1; i < lines.length; i += 1) {
    if (/^---[ \t]*\r?$/.test(lines[i])) {
      end = i
      break
    }
  }
  if (end < 0) return { frontmatter: {}, body: text, hasFrontmatter: false }
  const head = lines.slice(1, end)
  const body = lines.slice(end + 1).join('\n')
  return { frontmatter: parseYamlSubset(head), body, hasFrontmatter: true }
}

/** 只认一层映射的小 YAML 解析器。 */
export function parseYamlSubset(lines) {
  const out = {}
  let index = 0
  while (index < lines.length) {
    const line = lines[index]
    index += 1
    if (!line.trim() || /^\s*#/.test(line)) continue
    const match = /^([A-Za-z0-9_.-]+)\s*:\s*(.*)$/.exec(line)
    if (!match) continue
    const key = match[1].toLowerCase()
    let value = match[2]
    if (/^[|>][+-]?$/.test(value.trim())) {
      // 多行块：吃到下一个顶格 key 之前。
      const block = []
      while (index < lines.length && (/^\s+/.test(lines[index]) || !lines[index].trim())) {
        block.push(lines[index].replace(/^\s{1,4}/, ''))
        index += 1
      }
      out[key] = block.join('\n').trim()
      continue
    }
    if (!value.trim()) {
      // 可能是 `- item` 列表，也可能是空值。
      const items = []
      while (index < lines.length) {
        const next = /^\s*-\s+(.*)$/.exec(lines[index])
        if (!next) break
        items.push(scalar(next[1]))
        index += 1
      }
      out[key] = items.length ? items : ''
      continue
    }
    out[key] = value.includes('[') || value.includes('，') || value.includes(', ')
      ? listValue(value)
      : scalar(value)
  }
  return out
}

/** 取一个字符串键（数组取第一个）。 */
function stringOf(value) {
  if (Array.isArray(value)) return value.length ? String(value[0]) : ''
  if (value === undefined || value === null) return ''
  return String(value)
}

/** 取一个数组键（字符串按逗号/空白再切一次）。 */
function arrayOf(value) {
  if (Array.isArray(value)) return value.map((item) => String(item)).filter(Boolean)
  const text = stringOf(value)
  if (!text) return []
  return text.split(/[,，\s]+/).map((item) => item.trim()).filter(Boolean)
}

const WIKILINK = /\[\[([^\]|#]+)(?:#[^\]|]*)?(?:\|[^\]]*)?\]\]/g

/**
 * 抽出正文里的 `[[链接]]`，按出现序去重。
 *
 * 只留目标部分：`[[notes/x.md|别名]]`、`[[notes/x.md#anchor]]` 都算 `notes/x.md`。
 */
export function extractLinks(body) {
  const out = []
  const seen = new Set()
  for (const match of String(body ?? '').matchAll(WIKILINK)) {
    const target = normalizePath(match[1].trim())
    if (!target || seen.has(target)) continue
    seen.add(target)
    out.push(target)
  }
  return out
}

/**
 * 链接 → 工作区里的候选路径。
 *
 * 笔记里写 `[[药水]]`、`[[notes/x.md]]`、`[[x]]` 都见过，所以依次试：
 * 原样、加 `.md`、相对当前文件目录、`notes/` 下。真正匹配时再按文件名兜底
 * （见 `matchSupersede`），所以这里只给「首选」。
 */
export function resolveLink(fromPath, raw) {
  const target = normalizePath(String(raw ?? '').trim())
  if (!target) return []
  const candidates = []
  const withExt = /\.(md|markdown)$/i.test(target) ? target : `${target}.md`
  candidates.push(withExt)
  if (!target.includes('/')) {
    const dir = normalizePath(fromPath).includes('/')
      ? normalizePath(fromPath).slice(0, normalizePath(fromPath).lastIndexOf('/'))
      : ''
    if (dir) candidates.push(`${dir}/${withExt}`)
    candidates.push(`notes/${withExt}`)
    candidates.push(withExt)
  }
  return [...new Set(candidates)]
}

/**
 * 把一条 `supersedes` 目标匹配到真实路径：先逐字，再按路径后缀，最后按文件名。
 *
 * 返回命中的路径，或 null。多个文件同名时取最短路径（`notes/x.md` 优于
 * `archive/2026/x.md`），因为笔记里通常指的是主目录那份。
 */
export function matchSupersede(target, paths) {
  const wanted = normalizePath(String(target ?? ''))
  if (!wanted) return null
  const withExt = /\.(md|markdown)$/i.test(wanted) ? wanted : `${wanted}.md`
  if (paths.has(withExt)) return withExt
  const bySuffix = [...paths].filter((path) => path.endsWith(`/${withExt}`))
  if (bySuffix.length) return bySuffix.sort((a, b) => a.length - b.length)[0]
  const bare = baseName(withExt)
  const byName = [...paths].filter((path) => baseName(path) === bare)
  if (byName.length) return byName.sort((a, b) => a.length - b.length)[0]
  return null
}

/**
 * 解析一份笔记：头、正文、标题、状态、关系。
 *
 * `mtime` 作为 `updated` 的兜底——没写头的文件按「最后一次改的时间」算新旧，
 * 这比把 1970 年当日期靠谱。
 */
export function parseDocument(path, raw, { mtime = 0 } = {}) {
  const { frontmatter, body, hasFrontmatter } = splitFrontmatter(raw)
  const declared = stringOf(frontmatter.status).toLowerCase().trim()
  const status = STATUSES.has(declared) ? declared : 'active'
  const updatedText = stringOf(frontmatter.updated)
    || stringOf(frontmatter.last_updated)
    || stringOf(frontmatter.date)
  const updatedAt = parseDay(updatedText) ?? (mtime ? new Date(mtime) : null)
  const supersedes = arrayOf(frontmatter.supersedes)
  const tags = arrayOf(frontmatter.tags)
  const title = stringOf(frontmatter.title)
    || headingOf(body)
    || baseName(path)
  return {
    path: normalizePath(path),
    title,
    body,
    hasFrontmatter,
    declaredStatus: declared,
    status,
    statusValid: !declared || STATUSES.has(declared),
    updatedAt: updatedAt ? updatedAt.toISOString() : null,
    updatedText: updatedText || null,
    supersedes,
    supersededBy: [],
    tags,
    links: extractLinks(body),
    frontmatter,
  }
}

/** `2026-10-30` / `2026/10/30` / ISO → Date（当本地当天零点）；读不出返回 null。 */
function parseDay(text) {
  const value = String(text ?? '').trim()
  if (!value) return null
  const ymd = /^(\d{4})[-/.](\d{1,2})[-/.](\d{1,2})/.exec(value)
  if (ymd) {
    const date = new Date(Number(ymd[1]), Number(ymd[2]) - 1, Number(ymd[3]))
    return Number.isNaN(date.getTime()) ? null : date
  }
  const date = new Date(value)
  return Number.isNaN(date.getTime()) ? null : date
}

/**
 * 把「谁推翻了谁」算成生效状态。
 *
 * 新条目的 `supersedes` 指向旧条目，旧条目自动变 superseded —— 这样「他改主意了」
 * 不会变成两条互相打架的记忆。旧条目自己写 `archived` 时保持 archived。
 * 反向关系记进 `supersededBy`，检索回执里能指回新条目。
 *
 * 直接改传入的文档对象，返回改动数。
 */
export function applySupersedes(docs) {
  const paths = new Set(docs.map((doc) => doc.path))
  let changed = 0
  for (const doc of docs) {
    doc.supersededBy = []
    if (doc.status === 'active' || doc.status === 'unfinished') doc.effectiveStatus = doc.status
    else doc.effectiveStatus = doc.status
  }
  const byPath = new Map(docs.map((doc) => [doc.path, doc]))
  for (const doc of docs) {
    if (doc.status === 'archived') continue
    for (const raw of doc.supersedes) {
      const target = matchSupersede(raw, paths)
      if (!target || target === doc.path) continue
      const old = byPath.get(target)
      if (!old) continue
      if (!old.supersededBy.includes(doc.path)) old.supersededBy.push(doc.path)
      if (old.status === 'archived') continue
      if (old.effectiveStatus !== 'superseded') {
        old.effectiveStatus = 'superseded'
        changed += 1
      }
    }
  }
  return changed
}
