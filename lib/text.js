/**
 * 文本小工具：CJK 感知的切词、token 估算、片段截取、路径归一。
 *
 * 全是纯函数，不碰 fs —— 检索的排序信号（覆盖率、片段、预算）都在这里算出来，
 * 好在测试里单独验。
 */

/** 汉字（含扩展 A、兼容区）、假名、谚文。用码位区间判断，比 Unicode 属性转义快，也够用。 */
const CJK_RANGES = [
  [0x3400, 0x4dbf], // 扩展 A
  [0x4e00, 0x9fff], // 基本区
  [0xf900, 0xfaff], // 兼容汉字
  [0x3040, 0x30ff], // 平假名 / 片假名
  [0xac00, 0xd7af], // 谚文音节
]

export function isCjk(ch) {
  if (!ch) return false
  const code = ch.codePointAt(0)
  for (const [lo, hi] of CJK_RANGES) {
    if (code >= lo && code <= hi) return true
  }
  return false
}

/** 字符数组（按码位切，不会把代理对劈两半）。 */
export function chars(text) {
  return Array.from(String(text ?? ''))
}

/**
 * token 估算：中日韩按 1 字 1 token（偏保守），其余按 3.5 字符 1 token。
 *
 * 宁可高估。注入预算是硬上限，超了就是把别人的上下文挤掉。
 */
export function estimateTokens(text) {
  const source = String(text ?? '')
  if (!source) return 0
  let cjk = 0
  let other = 0
  for (const ch of source) {
    if (isCjk(ch)) cjk += 1
    else other += 1
  }
  return Math.ceil(cjk + other / 3.5)
}

const TERM_RE = /[\u3400-\u4DBF\u4E00-\u9FFF\uF900-\uFAFF\u3040-\u30FF\uAC00-\uD7AF]+|[A-Za-z0-9_]+/g
/** 这些拉丁词在检索里等于噪声：出现频率高、区分度为零。 */
const LATIN_STOP = new Set([
  'the', 'and', 'for', 'are', 'but', 'not', 'you', 'all', 'can', 'her', 'was', 'one', 'our', 'out',
  'his', 'has', 'had', 'him', 'she', 'its', 'who', 'did', 'yes', 'this', 'that', 'with', 'from',
  'have', 'they', 'what', 'when', 'where', 'which', 'will', 'would', 'there', 'their', 'about',
])

/**
 * 把一句话切成检索单位：连续的 CJK 串算一个词，连续的拉丁/数字算一个词。
 *
 * 返回 [{ text, cjk }]，按原序。
 */
export function splitTerms(query) {
  const out = []
  for (const match of String(query ?? '').matchAll(TERM_RE)) {
    const text = match[0]
    if (!text) continue
    const cjk = isCjk(text[0])
    if (!cjk && LATIN_STOP.has(text.toLowerCase())) continue
    out.push({ text, cjk })
  }
  return out
}

/**
 * FTS5 trigram 的查询词：每个 CJK 词切成所有三字滑窗，拉丁词整词。
 *
 * trigram 只按「三字滑窗」建索引，所以 `药水还剩` 只有在原文里逐字出现才命中——
 * 一句自然话必须拆成多个三元组再 OR，否则几乎搜不到东西。这是本模块存在的原因。
 *
 * 长的词优先（话题通常在前面），结果去重并截到 max 个。
 */
export function queryTokens(query, { max = 24 } = {}) {
  const terms = [...splitTerms(query)].sort((a, b) => b.text.length - a.text.length)
  const out = []
  const seen = new Set()
  const push = (token) => {
    const key = token.toLowerCase()
    if (token.length < 3 || seen.has(key)) return
    seen.add(key)
    out.push(token)
  }
  for (const term of terms) {
    if (term.cjk) {
      const list = chars(term.text)
      for (let i = 0; i + 3 <= list.length; i += 1) push(list.slice(i, i + 3).join(''))
    } else {
      push(term.text.toLowerCase())
    }
  }
  return out.slice(0, max)
}

/**
 * 覆盖率用的词：CJK 全部二元组 + 拉丁整词。
 *
 * 二元组是中文里最稳的「词」近似：`药水`、`还剩` 这种两字片段既能逐个命中，
 * 又能用命中比例当相关度。整体逐字命中（覆盖率高）比 OR 一堆三元组可靠得多。
 */
export function coverageTerms(query, { max = 40 } = {}) {
  const out = []
  const seen = new Set()
  const push = (token) => {
    const key = token.toLowerCase()
    if (!token || seen.has(key)) return
    seen.add(key)
    out.push(token)
  }
  for (const term of splitTerms(query)) {
    if (!term.cjk) {
      if (term.text.length >= 2) push(term.text)
      continue
    }
    const list = chars(term.text)
    if (list.length === 1) {
      push(term.text)
      continue
    }
    for (let i = 0; i + 2 <= list.length; i += 1) push(list.slice(i, i + 2).join(''))
  }
  return out.slice(0, max)
}

/**
 * LIKE 兜底用的短词：长度 < 3 的词（trigram 索引不到）+ 长 CJK 词的全部二元组。
 *
 * 这部分就是 spec 里「小于 3 字的 query 走 LIKE」的落地，顺带把两字词（`药水`）
 * 也补上——中文两字词太多，光靠 FTS 会漏。
 */
export function likeTerms(query, { max = 8 } = {}) {
  const out = []
  const seen = new Set()
  const push = (token) => {
    const key = token.toLowerCase()
    if (!token || seen.has(key)) return
    seen.add(key)
    out.push(token)
  }
  for (const term of splitTerms(query)) {
    if (term.cjk) {
      const list = chars(term.text)
      if (list.length <= 2) push(term.text)
      else {
        for (let i = 0; i + 2 <= list.length; i += 1) push(list.slice(i, i + 2).join(''))
      }
    } else if (term.text.length < 3) {
      push(term.text)
    }
  }
  return out.slice(0, max)
}

/** 压缩空白：换行、制表、连续空格都变一个空格。注入和回执里都不该出现换行。 */
export function oneLine(text) {
  return String(text ?? '').replace(/\s+/g, ' ').trim()
}

/** 取正文第一行有内容的标题（去掉 # 和包围的 **）。 */
export function headingOf(text) {
  for (const line of String(text ?? '').split('\n')) {
    const trimmed = line.trim()
    if (!trimmed) continue
    if (/^[-*+]\s/.test(trimmed)) continue
    return trimmed.replace(/^#{1,6}\s*/, '').replace(/^[*_]{1,3}|\*{1,3}$/g, '').trim()
  }
  return ''
}

/**
 * 片段：命中词附近 ±radius 字。
 *
 * 命中点取「最长的一段逐字命中」——先用完整的 query 找，找不到再用最长的覆盖率词。
 * 都找不到就退回正文开头。返回一行压缩过的文本。
 */
export function snippet(body, terms, { radius = 80 } = {}) {
  const text = oneLine(body)
  if (!text) return ''
  const anchors = [...new Set(terms.filter((term) => term && term.length >= 2))].sort((a, b) => b.length - a.length)
  let at = -1
  let hit = ''
  for (const anchor of anchors) {
    at = text.indexOf(anchor)
    if (at >= 0) {
      hit = anchor
      break
    }
  }
  if (at < 0) return text.length <= radius * 2 ? text : `${text.slice(0, radius * 2)}…`
  const start = Math.max(0, at - radius)
  const end = Math.min(text.length, at + hit.length + radius)
  return `${start > 0 ? '…' : ''}${text.slice(start, end)}${end < text.length ? '…' : ''}`
}

/** 路径归一：正斜杠、去 ./ 前缀、去尾部斜杠。索引键与展示都用这个形式。 */
export function normalizePath(value) {
  return String(value ?? '')
    .replace(/\\/g, '/')
    .replace(/^\.\//, '')
    .replace(/\/+$/, '')
}

/** 展示用路径：`./notes/a.md` → `notes/a.md`。 */
export function displayPath(value) {
  return normalizePath(value) || String(value ?? '')
}

/** 文件名（不含目录、不含扩展名），用作没标题的文档的兜底标题。 */
export function baseName(path) {
  const normalized = normalizePath(path)
  const cut = normalized.lastIndexOf('/')
  const name = cut >= 0 ? normalized.slice(cut + 1) : normalized
  return name.replace(/\.(md|markdown)$/i, '')
}

/** ISO 时间 → `YYYY-MM-DD`（本地时区）；读不出来返回空串。 */
export function dayOf(value) {
  if (!value) return ''
  const date = value instanceof Date ? value : new Date(value)
  if (Number.isNaN(date.getTime())) return ''
  const month = String(date.getMonth() + 1).padStart(2, '0')
  const day = String(date.getDate()).padStart(2, '0')
  return `${date.getFullYear()}-${month}-${day}`
}

/** 多久以前（天，浮点）；无效输入返回 null。 */
export function ageDays(value, now = Date.now()) {
  if (!value) return null
  const date = value instanceof Date ? value : new Date(value)
  if (Number.isNaN(date.getTime())) return null
  return Math.max(0, (now - date.getTime()) / 86_400_000)
}

/** 稳定截断：按字符数切，尾部标明被截。 */
export function clip(text, limit, note = '…') {
  const source = String(text ?? '')
  if (source.length <= limit) return source
  return `${source.slice(0, limit)}${note}`
}

/** 百分比（0–1 → 整数百分比），日志里看覆盖率用。 */
export function percent(ratio) {
  return `${Math.round((Number(ratio) || 0) * 100)}%`
}
