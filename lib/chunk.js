/**
 * 分块：按标题/空行把正文切成 300–800 字的 chunk。
 *
 * 为什么要分块：整篇笔记当一个检索单位时，一篇 130KB 的交接笔记会把所有话题混在
 * 一起，命中一句就把整篇塞进上下文（预算立刻炸），片段也没法定位。
 *
 * 切法：先按 markdown 标题分段（标题进 chunk 的 title，带上文档标题做上下文），
 * 段内按空行分段，再把段落贪心攒到接近 max 就切；超长的单段按句末标点硬切。
 * 代码块（```）不切。
 *
 * chunk 的划分不追求稳定：文件一改，后面的 chunk_no 可能整体挪位，所以引用计数
 * 只按文件记，不按 chunk 记（见 store.recordRef）。
 */

import { chars, headingOf } from './text.js'

const FENCE = /^\s*(```|~~~)/
const HEADING = /^#{1,6}\s+/

/** 把正文切成「块」：块是合并不再拆的最小单位（段落、代码块、标题行）。 */
export function blocksOf(body) {
  const lines = String(body ?? '').replace(/\r\n/g, '\n').split('\n')
  const blocks = []
  let buffer = []
  let fence = false

  const flush = () => {
    const text = buffer.join('\n').trim()
    if (text) blocks.push(text)
    buffer = []
  }

  for (const line of lines) {
    if (FENCE.test(line)) {
      // 代码块整块留下，里面的空行不作为分段。
      buffer.push(line)
      fence = !fence
      continue
    }
    if (fence) {
      buffer.push(line)
      continue
    }
    if (!line.trim()) {
      flush()
      continue
    }
    if (HEADING.test(line)) {
      flush()
      blocks.push(line.trim())
      continue
    }
    buffer.push(line)
  }
  flush()
  return blocks
}

/** 超长段落按句末标点切成不超过 max 的片。 */
export function hardSplit(text, max) {
  const list = chars(text)
  const out = []
  let start = 0
  while (start < list.length) {
    if (list.length - start <= max) {
      out.push(list.slice(start).join(''))
      break
    }
    let end = start + max
    // 往回找最近的句末/换行，最多退 120 字；找不到就硬切。
    const floor = Math.max(start + Math.floor(max * 0.6), end - 120)
    let cut = -1
    for (let i = end; i >= floor; i -= 1) {
      const ch = list[i - 1]
      if (ch === '。' || ch === '！' || ch === '？' || ch === '\n' || ch === '.' || ch === '!' || ch === '?') {
        cut = i
        break
      }
    }
    if (cut > start) end = cut
    out.push(list.slice(start, end).join(''))
    start = end
  }
  return out.filter((piece) => piece.trim())
}

/** 去掉标题行之后还剩多少正文：只有标题的空段不值得进索引。 */
export function indexableLength(text) {
  return String(text ?? '').replace(/^#{1,6}\s+.*$/gm, '').trim().length
}

/**
 * 切一块文档。
 *
 * 返回 [{ chunk_no, title, body, chars }]，chunk_no 从 0 连续编号。
 * 正文为空的文档返回空数组。
 */
export function chunkDocument(body, { title = '', min = 300, max = 800 } = {}) {
  const text = String(body ?? '').replace(/\r\n/g, '\n')
  if (!text.trim()) return []

  const limit = Math.max(120, Number(max) || 800)
  const floor = Math.min(Math.max(60, Number(min) || 300), limit)

  const blocks = blocksOf(text)
    .map((block) => (HEADING.test(block) || block.length <= limit ? block : hardSplit(block, limit)))
    .flat()

  const chunks = []
  let current = []
  let size = 0
  let section = ''

  const flush = () => {
    const merged = current.join('\n\n').trim()
    if (indexableLength(merged) >= 8) {
      // 一级标题常常就是文档标题，别拼成「标题 · 标题」。
      const label = section && section !== title ? `${title}${title ? ' · ' : ''}${section}` : (section || title)
      chunks.push({ title: label, body: merged, chars: merged.length })
    }
    current = []
    size = 0
  }

  for (const block of blocks) {
    if (HEADING.test(block)) {
      flush()
      section = headingOf(block)
      current.push(block)
      size = block.length + 2
      continue
    }
    if (size > 0 && size + block.length + 2 > limit) flush()
    current.push(block)
    size += block.length + 2
  }
  flush()

  return mergeTinyTail(chunks, { floor, limit }).map((chunk, index) => ({ ...chunk, chunk_no: index }))
}

/**
 * 尾巴太短的 chunk 并回前一块，别让「## 备注\n一句话」单独占一条检索结果。
 *
 * 只在合并后仍不过分超限时做（1.3 × limit），否则宁可留着。
 */
function mergeTinyTail(chunks, { floor, limit }) {
  if (chunks.length < 2) return chunks
  const last = chunks[chunks.length - 1]
  const previous = chunks[chunks.length - 2]
  if (last.chars >= floor / 2) return chunks
  if (previous.chars + last.chars > limit * 1.3) return chunks
  const merged = {
    title: previous.title,
    body: `${previous.body}\n\n${last.body}`,
    chars: previous.body.length + last.body.length + 2,
  }
  return [...chunks.slice(0, -2), merged]
}
