/**
 * 自动注入：自己拼 query、自己决定注什么、自己记住上一轮注入过什么。
 *
 * query 从哪来（spec §3.3）：
 *   1. 最近 2 条「人说的话」——事件库里 origin=external 的最近消息；
 *   2. `worlds.memory.queryHint`（操作者可以钉一个当前话题，比如游戏名）；
 *   3. 都没有时退到「最近改动的文件」——至少说明最近在忙什么。
 *
 * 去重：同一批记忆连续两轮不重复注入。做法是记住上一轮注入的 path，下一轮先给
 * 没注入过的；只剩重复项时才允许重复（否则话题没变时前缀会突然变空）。
 */

import { dayOf, oneLine } from './text.js'

/** 事件类型里带这些词的，当「消息」；带另一批词的，当噪声。 */
const MESSAGE_TYPES = /message|chat|text|msg|reply|inbox/i
const NOISE_TYPES = /turn|choice|self|touch|notice|heartbeat|reminder|delivery|system|tool|state|delivered/i
/** 这种前缀是投递标注（`[15:44] [typed] `），不是正文。 */
const ANNOTATION = /^\s*(?:\[[^\]]{0,24}\]\s*)+/
/** 「送达了 #21870」这类回执不是话题。 */
const RECEIPT = /^(送达了|delivered|已读|sent)/i
/**
 * 纯应答：`ok` / `嗯` / `好` / `收到` / 单独一个表情。
 *
 * 最后一句是「阿梦:ok」时不该拿它去检索——那不叫话题。滤掉它，往后取真正说了
 * 东西的那两条；一条都没有就退到最近改动的文件。
 */
const ACK = /^(ok|okay|kk|k|嗯+|哦+|噢+|好+|行|可以|收到|了解|明白|谢谢|谢啦|在吗|在不在|早|早安|晚安|哈哈+|hhh+|草|nb|👍+|[.。?？!！~～…]+|\d{1,2})$/i
/** 说话人前缀：`阿梦:` / `小窝 · 初雪(id:1):` / `BigFatFish:`。 */
const SPEAKER = /^[^:：]{1,24}[:：]\s*/

/**
 * 从一条事件正文里剥出可当 query 的部分。
 *
 * 返回空串表示这条不该进 query。
 */
export function messageTextOf(event) {
  const text = oneLine(event?.text ?? '')
  if (!text) return ''
  if (RECEIPT.test(text)) return ''
  if (/^\[system\]/i.test(text)) return ''
  const stripped = text.replace(ANNOTATION, '').trim()
  if (!stripped || stripped.length < 2) return ''
  // 去掉说话人前缀，剩下的只有一个「ok」就当没说。
  const said = stripped.replace(SPEAKER, '').trim()
  if (!said || said.length < 2) return ''
  if (ACK.test(said)) return ''
  return stripped.length > 240 ? stripped.slice(0, 240) : stripped
}

/**
 * 最近的人类消息。
 *
 * 只读事件库里 origin=external、且不是本 World 自己推的那些；再看一圈 cursor 上限，
 * 免得把整库翻一遍。
 */
export function recentHumanMessages(store, { worldId = 'memory', limit = 24, take = 2, allowedSources = null } = {}) {
  if (!store) return []
  let latest = 0
  try {
    latest = Number(store.latestCursor()) || 0
  } catch {
    return []
  }
  if (!latest) return []
  let events = []
  try {
    events = store.range({ fromCursor: Math.max(1, latest - 800), toCursor: latest, origin: 'external', limit }) ?? []
  } catch {
    return []
  }

  const strong = []
  const weak = []
  for (const event of events) {
    const source = String(event?.source ?? '')
    if (source === worldId) continue
    if (allowedSources && allowedSources.size && !allowedSources.has(source)) continue
    const type = String(event?.type ?? '')
    const text = messageTextOf(event)
    if (!text) continue
    if (NOISE_TYPES.test(type)) continue
    if (MESSAGE_TYPES.test(type)) strong.push(text)
    else if (!/^pwa\./.test(type)) weak.push(text)
  }
  const picked = [...(strong.length ? strong : weak)].slice(-take)
  return picked
}

/**
 * 拼 query。
 *
 * 顺序：最近的人话（最重要）→ 操作者钉的提示词 → 最近改动的文件。
 * 总长截到 maxChars，中文问句 300 字足够触发一次检索了。
 */
export function buildQuery({ messages = [], hint = '', recentTitles = [], maxChars = 320 } = {}) {
  const parts = []
  for (const message of messages) {
    if (message) parts.push(message)
  }
  if (hint) parts.push(hint)
  if (!parts.length) {
    // 没有新消息：用最近改动的文件名当话题。"notes/pwa-run-state.md" → "pwa run state"。
    for (const title of recentTitles) parts.push(title)
  }
  const joined = oneLine(parts.join(' '))
  return joined.length > maxChars ? joined.slice(0, maxChars) : joined
}

/** 从文档摘要里挑最近改动的几篇，给 query 兜底。 */
export function recentTitles(docs, take = 3) {
  return [...docs]
    .filter((doc) => doc.status !== 'archived')
    .sort((a, b) => (b.mtime || 0) - (a.mtime || 0))
    .slice(0, take)
    .map((doc) => String(doc.path).replace(/\.(md|markdown)$/i, '').replace(/[/_-]+/g, ' '))
}

/**
 * 渲染成前缀里那一段。
 *
 * 格式照 spec：
 *   - [[notes/cet6-plan-2026-12-12.md]] 单词在「不背单词」上，每天 50 个…（2026-10-29）
 * 空结果返回空串（模板会用缺省文案兜住）。
 */
export function renderRecall(results, { maxItems = 5 } = {}) {
  const lines = []
  for (const item of results.slice(0, maxItems)) {
    const day = dayOf(item.updated)
    const tail = day ? `（${day}）` : ''
    const flag = item.status === 'unfinished' ? '（未完成）' : ''
    lines.push(`- [[${item.path}]] ${oneLine(item.snippet)}${flag}${tail}`)
  }
  return lines.join('\n')
}

/**
 * 「同一批记忆连续两轮不重复注入」的缓存。
 *
 * pick 给出这一轮该注的；commit 记住它们。只有找不到新东西时才允许重复，
 * 且优先补最早注入过的（这样话题不变时内容也不会原地不动）。
 */
export class RecallCache {
  constructor() {
    /** @type {string[]} 上一轮注入的 path（按注入顺序） */
    this.last = []
  }

  pick(results, limit) {
    const previous = new Set(this.last)
    // 严格「连续两轮不重复」：这轮只给上轮没给过的；全给过就这轮不注（宁可空一轮）。
    return results.filter((item) => !previous.has(item.path)).slice(0, limit)
  }

  commit(results) {
    this.last = results.map((item) => item.path)
  }

  reset() {
    this.last = []
  }
}
