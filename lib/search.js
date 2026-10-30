/**
 * 检索：FTS5(trigram) + LIKE 兜底 + 本地向量，三路用 RRF 融合，再按
 * 覆盖率、引用次数、时间衰减重排，最后按文件去重并卡住 token 预算。
 *
 * 为什么不是「FTS 一把梭」：trigram 索引只在查询串**逐字出现**时命中。一句自然的
 * 中文问句（`我上次说的药水还剩几瓶`）在原文里几乎不可能整段出现，所以：
 *
 *   1. 查询拆成三字滑窗，OR 进 FTS —— 召回「像」的段；
 *   2. 两字词与短词走 LIKE —— 补上 trigram 索引不到的粒度；
 *   3. 本地向量算余弦 —— 补上「字面不重合但语义近」的段；
 *   4. RRF（1/(60+rank) 求和）融合三路的名次，而不是硬拼三套不同量纲的分数；
 *   5. 用「命中的二元组比例」（覆盖率）当最终相关度，压制 OR 带来的噪声。
 *
 * 参数都能在 `worlds.memory.*` 里调；默认值就是 spec 里写的 k=5、RRF 60、
 * 引用加成 0.3、注入上限 2000 token。
 */

import { BUILTIN_DIM, cosine, embedBuiltin } from './embed.js'
import { HIDDEN_STATUSES } from './frontmatter.js'
import {
  ageDays,
  coverageTerms,
  estimateTokens,
  likeTerms,
  oneLine,
  percent,
  queryTokens,
  snippet,
} from './text.js'

export const DEFAULTS = {
  k: 5,
  rrfK: 60,
  refBoost: 0.3,
  refWindowDays: 30,
  halfLifeDays: 90,
  decayFloor: 0.15,
  perFile: 2,
  candidateLimit: 50,
  budgetTokens: 2000,
  maxChars: 4000,
}

/** 把一条有序候选列表折成 RRF 分。 */
function fuse(rrf, ranked, weight = 1, rrfK = DEFAULTS.rrfK) {
  for (let rank = 0; rank < ranked.length; rank += 1) {
    const id = ranked[rank].id ?? ranked[rank]
    const key = Number(id)
    if (!Number.isFinite(key)) continue
    rrf.set(key, (rrf.get(key) ?? 0) + weight / (rrfK + rank + 1))
  }
}

/**
 * 覆盖率：命中词的加权和 / 全部词的加权和。
 *
 * 这是「这段真的在讲这个问题吗」的判据。OR 一堆三元组会让弱相关段也进候选，
 * 覆盖率把它们压回去；逐字命中越多，越可能是想找的那段。
 *
 * 权重来自候选池里的文档频率（IDF）：`怎么`、`考试` 这种在候选中到处都是的
 * 二元组几乎没有区分度，而 `六级` 只在两三段里出现——命中它才说明找对了。
 * 候选池本来就是「已经有点像」的那一百多段，在这个池子里算 IDF 既便宜又准。
 */
function weightsOf(terms, pool) {
  const size = Math.max(1, pool ? pool.size : 1)
  const weights = new Map()
  let total = 0
  for (const term of terms) {
    let df = 0
    if (pool) {
      for (const chunk of pool.values()) {
        if (chunk.haystack.includes(term)) df += 1
      }
    }
    if (!df) {
      // 候选池里一条都没有：这个词在这次检索里根本够不着，不该拉低覆盖率。
      weights.set(term, 0)
      continue
    }
    // df 越小权重越高：满池都有的词 ≈ 0.7，只有一两条命中的词 ≈ 4。
    const weight = Math.log(1 + size / (1 + df))
    weights.set(term, weight)
    total += weight
  }
  return { weights, total: total || 1 }
}

/** 用给定权重算一段文本的覆盖率（0–1）。 */
function coverageOf(text, weightSet) {
  if (!weightSet.total) return 0
  let hit = 0
  for (const [term, weight] of weightSet.weights) {
    if (text.includes(term)) hit += weight
  }
  return Math.min(1, hit / weightSet.total)
}

/** 时间衰减：半衰期 halfLifeDays，最低 decayFloor，别让旧笔记彻底消失。 */
function decayOf(updatedMs, { halfLifeDays, decayFloor }, now) {
  const days = ageDays(updatedMs, now)
  if (days == null) return decayFloor
  if (!halfLifeDays || halfLifeDays <= 0) return 1
  return Math.max(decayFloor, 0.5 ** (days / halfLifeDays))
}

/**
 * 主检索。
 *
 * 返回 [{ path, title, snippet, score, status, updated, chunks, tokens }]，已按分数
 * 排好、按文件去重、总 token 不超预算。索引不可用时由调用方走 fallback，这里只
 * 处理「有 store」的情况。
 */
export function searchMemory({
  store,
  query,
  k = DEFAULTS.k,
  status = 'active',
  maxAgeDays = 0,
  pathPrefix = '',
  budgetTokens = DEFAULTS.budgetTokens,
  refBoost = DEFAULTS.refBoost,
  rrfK = DEFAULTS.rrfK,
  halfLifeDays = DEFAULTS.halfLifeDays,
  decayFloor = DEFAULTS.decayFloor,
  perFile = DEFAULTS.perFile,
  candidateLimit = DEFAULTS.candidateLimit,
  vector = null,
  now = Date.now(),
  log = null,
} = {}) {
  const wanted = Math.max(1, Math.min(20, Number(k) || DEFAULTS.k))
  const tokens = queryTokens(query)
  const shortTerms = likeTerms(query)
  const terms = coverageTerms(query)
  if (!tokens.length && !shortTerms.length) return []

  const rrf = new Map()
  const fts = store.ftsSearch(tokens, { limit: candidateLimit })
  fuse(rrf, fts, 1, rrfK)
  const like = store.likeSearch(shortTerms, { limit: candidateLimit })
  fuse(rrf, like, 1.15, rrfK)

  if (vector !== false) {
    try {
      const queryVector = vector ?? embedBuiltin(query, BUILTIN_DIM)
      const hits = store.vectorSearch(queryVector, { limit: candidateLimit })
      fuse(rrf, hits, 1.0, rrfK)
    } catch (error) {
      log?.(`向量召回失败，跳过：${error instanceof Error ? error.message : String(error)}`)
    }
  }

  if (!rrf.size) return []

  const chunks = store.chunksByIds([...rrf.keys()])
  if (!chunks.size) return []

  // 候选池 + 每段的 haystack 只算一次：IDF 与覆盖率都要用。
  // haystack 小写，词也小写——否则 `Telegram` 这种大小写混写的查询永远匹配不上。
  for (const chunk of chunks.values()) {
    chunk.haystack = `${chunk.title}\n${chunk.body}`.toLowerCase()
  }
  const lowerTerms = terms.map((term) => term.toLowerCase())
  const weights = weightsOf(lowerTerms, chunks)
  // 片段优先围绕「最有区分度」的词取，而不是最长的那个。
  const anchors = [...terms].sort((a, b) => (weights.weights.get(b.toLowerCase()) ?? 0) - (weights.weights.get(a.toLowerCase()) ?? 0))

  const docs = new Map(store.allDocs().map((doc) => [doc.path, doc]))
  const since = now - DEFAULTS.refWindowDays * 86_400_000
  const refs = store.refCounts(since)
  const cutoff = maxAgeDays > 0 ? now - maxAgeDays * 86_400_000 : 0

  const scored = []
  for (const [id, base] of rrf) {
    const chunk = chunks.get(id)
    if (!chunk) continue
    const doc = docs.get(chunk.path)
    if (pathPrefix && !chunk.path.startsWith(pathPrefix) && !chunk.path.includes(pathPrefix)) continue
    if (doc) {
      if (status === 'any' || status === '*') {
        // status:any 也至少把 archived 挡在外面：归档是明确的「别再用」。
        if (doc.status === 'archived') continue
      } else if (status === 'active') {
        if (HIDDEN_STATUSES.has(doc.status)) continue
      } else if (doc.status !== status) {
        continue
      }
    }
    const updatedMs = doc?.updatedAt ?? doc?.mtime ?? null
    if (cutoff && updatedMs && updatedMs < cutoff) continue
    const coverage = coverageOf(chunk.haystack, weights)
    const cited = refs.get(chunk.path) ?? 0
    const boost = 1 + refBoost * Math.min(10, cited)
    const decay = decayOf(updatedMs, { halfLifeDays, decayFloor }, now)
    const score = base * (0.55 + 0.95 * coverage) * boost * decay
    scored.push({
      id,
      path: chunk.path,
      chunkNo: chunk.chunkNo,
      coverage,
      cited,
      score,
      title: chunk.title,
      body: chunk.body,
      status: doc?.status ?? 'active',
      updated: doc?.updatedAt ?? doc?.mtime ?? null,
      docTitle: doc?.title ?? '',
    })
  }

  scored.sort((a, b) => b.score - a.score)

  // 按文件去重：一个文件最多 perFile 段，文件分 = 最好那段 + 其余段的 1/3。
  const files = new Map()
  for (const item of scored) {
    const entry = files.get(item.path)
    if (!entry) {
      files.set(item.path, { path: item.path, items: [item], score: item.score })
      continue
    }
    if (entry.items.length >= perFile) continue
    entry.items.push(item)
    entry.score += item.score / 3
  }

  const ranked = [...files.values()].sort((a, b) => b.score - a.score)
  const out = []
  let used = 0
  for (const entry of ranked) {
    if (out.length >= wanted) break
    const best = entry.items[0]
    const text = oneLine(snippet(best.body, [...anchors, query], { radius: 80 }))
    const line = `- [[${entry.path}]] ${text}`
    const cost = estimateTokens(line)
    if (out.length > 0 && used + cost > budgetTokens) break
    used += cost
    out.push({
      path: entry.path,
      title: best.docTitle || best.title || entry.path,
      snippet: text,
      score: Number(best.score.toFixed(4)),
      coverage: Number((entry.items.reduce((sum, item) => sum + item.coverage, 0) / entry.items.length).toFixed(3)),
      cited: entry.items.reduce((sum, item) => sum + item.cited, 0),
      status: best.status,
      updated: best.updated,
      chunks: entry.items.map((item) => ({ chunk_no: item.chunkNo, score: Number(item.score.toFixed(4)) })),
      tokens: cost,
    })
  }
  return out
}

/** 检索结果的诊断摘要（日志与面板用）。 */
export function describeSearch(query, results) {
  const head = results.slice(0, 5).map((item) => `${item.path}(${item.score})`).join(', ')
  return `query=${JSON.stringify(oneLine(query).slice(0, 40))} hits=${results.length} ${head}`
}

/**
 * 覆盖率低于这个值时，宁可认为「没想起来」，也不要把弱相关的东西塞进前缀。
 *
 * 直接问句子（`我上次说的药水还剩几瓶`）时查询里的二元组很多是虚词，覆盖率天然
 * 偏低，所以阈值只用来挡掉最差的一档。
 */
export const MIN_INJECT_COVERAGE = 0.12

/**
 * 注入前的过滤：覆盖率太低的不要，明显比第一名差太多的也不要。
 *
 * 相对门槛（minRelative）比绝对门槛更稳：候选池整体偏弱时，绝对门槛会把唯一
 * 沾边的那条也切掉；相对门槛只砍尾巴，始终给最好的几条机会。
 */
export function filterForInject(results, { minCoverage = MIN_INJECT_COVERAGE, minRelative = 0.35 } = {}) {
  if (!results.length) return []
  const scores = results.map((item) => Number(item.score)).filter((value) => Number.isFinite(value))
  const best = scores.length ? Math.max(...scores) : 0
  return results.filter((item) => {
    if (item.coverage < minCoverage) return false
    const score = Number(item.score)
    if (!Number.isFinite(score) || !best) return true
    return score >= best * minRelative
  })
}

/** 人读的一行，日志/测试里用。 */
export function formatHits(results) {
  return results.map((item) => `${item.path} · ${percent(item.coverage)} · ${item.score}`).join('\n')
}
