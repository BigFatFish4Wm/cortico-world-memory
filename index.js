/**
 * 记忆检索（Coopanion World）：把工作区的 markdown 建成本地全文 + 向量索引，
 * 在每次重建 system 前缀时自动捞几条相关笔记塞进去，另给工具按需检索。
 *
 * 这是 spec `memory-retrieval-spec-2026-10-30.md` 的落地：
 *   - 索引：`<workspace>/.index/memory.db`，SQLite + FTS5(trigram)，可随时删了重建；
 *   - 增量：按 mtime+size 判「要不要重读」，hash 变了才重切；
 *   - 检索：FTS + LIKE 兜底 + 本地向量，RRF 融合，引用加成 + 时间衰减，
 *           按文件去重，总注入硬上限 2000 token；
 *   - 事实：`status: active|superseded|archived` + `supersedes` 自动作废旧条目；
 *   - 注入：`envPromptVars()` 返回 `memory.recall`，模板里就是「相关记忆」那一段；
 *           同一批记忆连续两轮不重复注入；
 *   - 兜底：索引不可用时不报错，退回直接扫文件的 grep。
 *
 * 纯本地、零 API 成本：不调用任何外部模型，向量是本地算的（默认哈希 n-gram，
 * 装了 onnxruntime-node + 模型就换成真 embedding）。
 */

import { existsSync, watch } from 'node:fs'
import { homedir } from 'node:os'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

import { BUILTIN_DIM, createOnnxEmbedder, embedBuiltin } from './lib/embed.js'
import { grepNotes } from './lib/fallback.js'
import { buildQuery, RecallCache, recentHumanMessages, recentTitles, renderRecall } from './lib/recall.js'
import { DEFAULT_SKIP_DIRS, syncIndex } from './lib/scan.js'
import { filterForInject, searchMemory } from './lib/search.js'
import { clip, dayOf, oneLine } from './lib/text.js'

const WORLD_ID = 'memory'
const WORLD_BUILD = '1.0.0'
const ENV_PROMPT_FILE = fileURLToPath(new URL('./ENV_PROMPT.md', import.meta.url))
/** 监听只关心笔记文件。 */
const NOTE_FILE = /\.(md|markdown)$/i

/** 前缀构建时给检索的预算：超了就这一轮不注，下次再来。绝不让前缀构建卡住。 */
const RECALL_BUDGET_MS = 1500
/** 两次扫描的最小间隔：`envPromptVars` 可能被频繁调用，别每次全量 walk。 */
const MIN_SCAN_INTERVAL_MS = 3000
/** query 缓存：同一轮里的多次前缀构建复用同一个 query。 */
const QUERY_TTL_MS = 15_000

const noArgs = { type: 'object', properties: {}, additionalProperties: false }

function defaults() {
  return {
    enabled: false,
    /** 索引哪个目录；空 = `<botDir>/workspace`（Coopanion 的工作区）。 */
    workspace: '',
    /** 索引文件；空 = `<workspace>/.index/memory.db`。 */
    indexPath: '',
    /** 跳过的目录（逗号分隔）。 */
    skipDirs: DEFAULT_SKIP_DIRS.join(','),
    /** 单篇笔记最多读多大；再大的只跳过，不进索引。 */
    maxFileKb: 2048,
    /** 分块长度区间（字）。 */
    chunkMin: 300,
    chunkMax: 800,
    /** 每轮注入几条。 */
    topK: 5,
    /** 每轮注入的 token 硬上限。 */
    budgetTokens: 2000,
    /** 关掉自动注入（工具仍然可用）。 */
    inject: true,
    /** 覆盖率低于这个值的候选不进前缀。 */
    minCoverage: 0.12,
    /** 时间衰减半衰期（天）；0 = 不衰减。 */
    halfLifeDays: 90,
    /** 30 天内每被引用一次加多少分。 */
    refBoost: 0.3,
    /** auto = 有本地向量就算；off = 只用全文。 */
    vector: 'auto',
    /** 可选：本地 ONNX 模型目录（model.onnx + vocab.txt）。空 = 用内置哈希向量。 */
    embedModel: '',
    /** 后台增量扫描间隔（秒）。 */
    scanSeconds: 30,
    /** 检索只回这么久以内改过的笔记；0 = 不限。 */
    maxAgeDays: 0,
    /** 工具默认的 status 过滤。 */
    status: 'active',
    /** 钉一个当前话题关键词（会拼进自动检索的 query）。 */
    queryHint: '',
    /** 只把这些来源的事件当「人说的话」（逗号分隔）；空 = 除了本 World 都算。 */
    humanSources: '',
    /** 工具回执的字符上限。 */
    maxChars: 4000,
    /** WebUI 面板里试检索用的条数。 */
    probeK: 5,
  }
}

/** 逗号/分号/空白分隔的配置串 → 数组。 */
function listOf(value) {
  return String(value ?? '')
    .split(/[,;，、\s]+/)
    .map((item) => item.trim())
    .filter(Boolean)
}

class MemoryWorld {
  constructor({ ctx, cfg }) {
    this.id = WORLD_ID
    this.ctx = ctx ?? {}
    this.cfg = cfg ?? defaults()
    this.host = null
    this.store = null
    this.engine = 'none'
    this.openError = ''
    this.embedder = null
    this.embedKind = 'none'
    this.scanTask = null
    this.scanTimer = null
    this.watcher = null
    this.watchTimer = null
    this.lastScanAt = 0
    this.lastScan = null
    this.lastQuery = ''
    this.lastQueryAt = 0
    this.lastRecall = { at: 0, query: '', paths: [], tokens: 0, text: '' }
    this.cache = new RecallCache()
    this.ready = null
    this.startedAt = null
  }

  // ------------------------------------------------------------ 路径与配置

  workspace() {
    const configured = String(this.cfg?.workspace ?? '').trim()
    if (configured) return resolve(configured)
    const botDir = this.ctx?.botDir || join(homedir(), '.coopanion')
    return join(botDir, 'workspace')
  }

  indexPath() {
    const configured = String(this.cfg?.indexPath ?? '').trim()
    if (configured) return resolve(configured)
    return join(this.workspace(), '.index', 'memory.db')
  }

  skipDirs() {
    const list = listOf(this.cfg?.skipDirs)
    return list.length ? list : DEFAULT_SKIP_DIRS
  }

  maxFileBytes() {
    const kb = Number(this.cfg?.maxFileKb) || 2048
    return Math.max(64, kb) * 1024
  }

  budgetTokens() {
    return Math.max(200, Math.min(8000, Number(this.cfg?.budgetTokens) || 2000))
  }

  topK() {
    return Math.max(1, Math.min(20, Number(this.cfg?.topK) || 5))
  }

  log(level, message, data) {
    try {
      const logger = this.host?.log
      if (!logger) return
      if (level === 'warn') logger.warn?.(message, data)
      else if (level === 'error') logger.error?.(message, data)
      else logger.info?.(message, data)
    } catch {
      // 日志写不进去不该影响检索。
    }
  }

  // ------------------------------------------------------------ 索引生命周期

  /** 打开索引 + 定好 embedder。只做一次；失败记下来，之后走 grep 兜底。 */
  async ensureReady() {
    if (this.ready) return this.ready
    this.ready = (async () => {
      const { openStore } = await import('./lib/store.js')
      const opened = await openStore({ file: this.indexPath() })
      if (!opened.ok) {
        this.engine = 'grep'
        this.openError = opened.reason
        this.log('warn', `[memory] 索引打不开，退回 grep 兜底：${opened.reason}`)
        return false
      }
      this.store = opened.store
      this.engine = 'sqlite'
      await this.initEmbedder()
      return true
    })()
    return this.ready
  }

  /** 向量层：默认内置哈希向量；配了模型且装得上 ORT 就用真 embedding。 */
  async initEmbedder() {
    const mode = String(this.cfg?.vector ?? 'auto').toLowerCase()
    if (mode === 'off' || mode === 'none' || mode === 'false') {
      this.embedder = null
      this.embedKind = 'off'
      return
    }
    const modelDir = String(this.cfg?.embedModel ?? '').trim()
    if (modelDir) {
      const onnx = await createOnnxEmbedder({ dir: modelDir })
      if (onnx.ok) {
        this.embedder = { kind: 'onnx', dim: onnx.dim ?? 0, embed: async (text) => onnx.embed(text) }
        this.embedKind = 'onnx'
        this.log('info', `[memory] 使用 ONNX embedding：${modelDir}`)
      } else {
        this.log('warn', `[memory] ONNX embedding 不可用（${onnx.reason}），用内置哈希向量`)
      }
    }
    if (!this.embedder) {
      this.embedder = { kind: 'builtin', dim: BUILTIN_DIM, embed: (text) => embedBuiltin(text, BUILTIN_DIM) }
      this.embedKind = 'builtin'
    }
    // 换了向量层就整体重建：不同维度的向量混在一起没法比。
    const stamp = `${this.embedKind}:${this.embedder.dim || 'auto'}`
    const previous = this.store?.getMeta('embed_stamp')
    if (previous && previous !== stamp) {
      this.log('warn', `[memory] embedding 从 ${previous} 换成 ${stamp}，重建索引`)
      this.store?.reset()
    }
    this.store?.setMeta('embed_stamp', stamp)
  }

  /** 增量扫描（带并发合并：同时来了就等同一个）。 */
  async scan({ deadline = Infinity } = {}) {
    if (this.scanTask) return this.scanTask
    const ready = await this.ensureReady()
    if (!ready || !this.store) return null
    this.scanTask = (async () => {
      try {
        const result = await syncIndex({
          store: this.store,
          workspace: this.workspace(),
          skipDirs: this.skipDirs(),
          maxFileBytes: this.maxFileBytes(),
          embed: this.embedder ? (text) => this.embedder.embed(text) : null,
          deadline,
        })
        this.lastScan = { ...result, at: Date.now() }
        this.lastScanAt = Date.now()
        if (result.added || result.updated || result.removed) {
          this.log('info', `[memory] 索引更新 +${result.added} ~${result.updated} -${result.removed}，${result.docs} 篇 / ${result.chunks} 段，${result.ms}ms`)
        }
        return result
      } catch (error) {
        this.log('warn', `[memory] 扫描失败：${error instanceof Error ? error.message : String(error)}`)
        return null
      } finally {
        this.scanTask = null
      }
    })()
    return this.scanTask
  }

  /** 需要新数据时扫一把；3 秒内扫过就跳过。 */
  async ensureFresh({ budgetMs = 1200 } = {}) {
    const ready = await this.ensureReady()
    if (!ready) return false
    if (Date.now() - this.lastScanAt < MIN_SCAN_INTERVAL_MS) return true
    await this.scan({ deadline: Date.now() + budgetMs })
    return true
  }

  // ------------------------------------------------------------ 检索

  /** 统一入口：索引在就用索引，不在就 grep 兜底。 */
  async search(query, { k, status, maxAgeDays, pathPrefix, budgetTokens } = {}) {
    const text = oneLine(query)
    if (!text) return []
    const want = Math.max(1, Math.min(20, Number(k) || this.topK()))
    const age = Number(maxAgeDays) > 0 ? Number(maxAgeDays) : Number(this.cfg?.maxAgeDays) || 0
    const state = String(status || this.cfg?.status || 'active')
    const budget = Math.max(20, Number(budgetTokens) || this.budgetTokens())

    const ready = await this.ensureReady()
    if (!ready || !this.store) {
      return grepNotes({
        workspace: this.workspace(),
        query: text,
        k: want,
        maxAgeDays: age,
        pathPrefix: pathPrefix ?? '',
        skipDirs: this.skipDirs(),
        maxFileBytes: this.maxFileBytes(),
        budgetTokens: budget,
      })
    }
    return searchMemory({
      store: this.store,
      query: text,
      k: want,
      status: state,
      maxAgeDays: age,
      pathPrefix: pathPrefix ?? '',
      budgetTokens: budget,
      refBoost: Number(this.cfg?.refBoost ?? 0.3),
      halfLifeDays: Number(this.cfg?.halfLifeDays ?? 90),
      log: (message) => this.log('warn', `[memory] ${message}`),
    })
  }

  /**
   * 这一轮自动注入该用哪个 query。
   *
   * 最近两条人话优先；没有就用最近改动的文件名。15 秒内复用，避免同一轮里
   * 前缀被重载两次就搜出两套结果。
   */
  async deriveQuery() {
    const now = Date.now()
    if (this.lastQueryAt && now - this.lastQueryAt < QUERY_TTL_MS) return this.lastQuery
    const allowed = listOf(this.cfg?.humanSources)
    let messages = []
    try {
      messages = recentHumanMessages(this.host?.store, {
        worldId: WORLD_ID,
        allowedSources: allowed.length ? new Set(allowed) : null,
      })
    } catch {
      messages = []
    }
    let titles = []
    if (!messages.length && this.store) {
      try {
        titles = recentTitles(this.store.allDocs(), 3)
      } catch {
        titles = []
      }
    }
    const query = buildQuery({
      messages,
      hint: oneLine(this.cfg?.queryHint ?? ''),
      recentTitles: titles,
    })
    this.lastQuery = query
    this.lastQueryAt = now
    return query
  }

  /**
   * 拼「相关记忆」那一段文本。
   *
   * 超预算、索引没好、query 为空都返回空串 —— 模板会用缺省文案兜住，
   * 前缀里也不会出现一个空标题。
   */
  async buildRecall() {
    const started = Date.now()
    await this.ensureFresh({ budgetMs: Math.min(1000, RECALL_BUDGET_MS / 2) })
    const query = await this.deriveQuery()
    if (!query) return ''

    // 换话题了就重置去重缓存：上一条笔记在新话题下可能又相关了。
    if (this.lastRecall.query && this.lastRecall.query !== query) this.cache.reset()

    const results = await this.search(query, { k: Math.max(this.topK(), 3), budgetTokens: this.budgetTokens() })
    const usable = filterForInject(results, { minCoverage: Number(this.cfg?.minCoverage ?? 0.12) })
    if (!usable.length) {
      this.lastRecall = { at: Date.now(), query, paths: [], tokens: 0, text: '' }
      return ''
    }
    const picked = this.cache.pick(usable, this.topK())
    this.cache.commit(picked)
    const text = renderRecall(picked, { maxItems: this.topK() })
    try {
      this.store?.recordRefs(picked.map((item) => item.path), 'inject')
    } catch {
      // 引用计数失败不影响注入。
    }
    this.lastRecall = {
      at: Date.now(),
      query,
      paths: picked.map((item) => item.path),
      tokens: picked.reduce((sum, item) => sum + (item.tokens ?? 0), 0),
      text,
      ms: Date.now() - started,
    }
    return text
  }

  // ------------------------------------------------------------ World 契约

  /**
   * 前缀里这一段的值。
   *
   * 工作区不存在就返回 null（整段省略）；出了任何错也只返回 null 或空串，
   * 绝不抛 —— 抛了 Core 会把整个 World 卸掉。
   */
  async envPromptVars() {
    try {
      if (!existsSync(this.workspace())) return null
      let recall = ''
      if (this.cfg?.inject !== false) {
        // 预算到点就先不注：检索继续在后台跑，下一条前缀生效。
        const build = this.buildRecall().catch((error) => {
          this.log('warn', `[memory] 检索失败，这一轮不注入：${error instanceof Error ? error.message : String(error)}`)
          return ''
        })
        recall = await Promise.race([
          build,
          new Promise((resolve) => setTimeout(() => resolve(''), RECALL_BUDGET_MS)),
        ])
      }
      const stats = this.stats()
      return {
        'memory.recall': recall || '',
        'memory.workspace': `${stats.docs} 篇 / ${stats.chunks} 段 · ${this.engine === 'sqlite' ? 'SQLite FTS5' : 'grep 兜底'}`,
      }
    } catch (error) {
      this.log('warn', `[memory] 前缀段构建失败，这一轮不注入：${error instanceof Error ? error.message : String(error)}`)
      return null
    }
  }

  stats() {
    if (!this.store) {
      return { docs: 0, chunks: 0, chars: 0, vectorized: 0, refs: 0, statuses: {}, bytes: 0 }
    }
    try {
      return { ...this.store.stats(), bytes: this.store.fileSize() }
    } catch {
      return { docs: 0, chunks: 0, chars: 0, vectorized: 0, refs: 0, statuses: {}, bytes: 0 }
    }
  }

  tools() {
    const clipText = (text) => clip(text, Math.max(500, Number(this.cfg?.maxChars) || 4000), '\n…(truncated)')

    return [
      {
        name: 'memory_search',
        description:
          '在自己的工作区笔记里检索（本地全文 + 本地向量，零 API 成本）。想不起细节、要确认以前写过什么的时候先用它，别凭上下文里的省略号猜。返回命中的文件、片段和相关度。',
        parameters: {
          type: 'object',
          properties: {
            query: { type: 'string', description: '关键词或一句话，中文不用分词；写成你真正想找的那件事' },
            k: { type: 'integer', description: '要几条（1–20，默认按配置的 5）' },
            status: {
              type: 'string',
              description: 'active（默认，只要还有效的）/ unfinished（只要没做完的）/ superseded（被推翻的）/ archived（归档）/ any（除归档都要）',
              enum: ['active', 'unfinished', 'superseded', 'archived', 'any'],
            },
            maxAgeDays: { type: 'integer', description: '只要这么多天内改过的笔记；0 / 不传 = 不限' },
            path: { type: 'string', description: '只在这个路径里搜，例如 notes/ 或 PARTNER.md' },
          },
          required: ['query'],
          additionalProperties: false,
        },
        tags: ['read'],
        barrierAfter: true,
        handler: async (args) => {
          const query = String(args?.query ?? '').trim()
          if (!query) return clipText(JSON.stringify({ ok: false, message: 'query 不能为空' }))
          const started = Date.now()
          await this.ensureFresh({ budgetMs: 1500 })
          const hits = await this.search(query, {
            k: args.k,
            status: args.status,
            maxAgeDays: args.maxAgeDays,
            pathPrefix: args.path ? String(args.path) : '',
            budgetTokens: 1500,
          })
          try {
            this.store?.recordRefs(hits.map((item) => item.path), 'search')
          } catch {
            // 同 inject：计数失败不影响回执。
          }
          return clipText(JSON.stringify({
            ok: true,
            engine: this.engine,
            query,
            count: hits.length,
            ms: Date.now() - started,
            hits: hits.map((item) => ({
              path: item.path,
              title: item.title,
              snippet: item.snippet,
              score: item.score,
              status: item.status,
              updated: dayOf(item.updated) || undefined,
              cited: item.cited || undefined,
            })),
            note: hits.length ? undefined : '没命中：换个说法，或先 memory_index 重建索引',
          }))
        },
      },
      {
        name: 'memory_index',
        description: '增量重建工作区记忆索引（按 mtime+hash，只重切改过的文件）。写完笔记想马上能搜到就调它，不然 30 秒内也会自动跟上。',
        parameters: {
          type: 'object',
          properties: {
            reset: { type: 'boolean', description: 'true = 丢掉现有索引从头建（索引可疑时才用）' },
          },
          additionalProperties: false,
        },
        tags: ['write'],
        barrierAfter: true,
        handler: async (args) => {
          const ready = await this.ensureReady()
          if (!ready || !this.store) {
            return clipText(JSON.stringify({ ok: false, engine: this.engine, message: this.openError || '索引不可用，检索会退回 grep' }))
          }
          if (args?.reset === true) {
            this.store.reset()
            this.cache.reset()
          }
          const result = await this.scan({ deadline: Date.now() + 20000 })
          return clipText(JSON.stringify({
            ok: Boolean(result),
            engine: this.engine,
            workspace: this.workspace(),
            index: this.indexPath(),
            ...(result ?? {}),
            embed: this.embedKind,
          }))
        },
      },
      {
        name: 'memory_status',
        description: '记忆索引状态：索引了哪个目录、多少篇/多少段、向量是否可用、最近注入了什么、上次扫描多久。排错先看它。',
        parameters: noArgs,
        tags: ['read'],
        barrierAfter: false,
        handler: async () => {
          await this.ensureReady()
          const stats = this.stats()
          return clipText(JSON.stringify({
            ok: true,
            build: WORLD_BUILD,
            engine: this.engine,
            embed: this.embedKind,
            workspace: this.workspace(),
            workspaceExists: existsSync(this.workspace()),
            index: this.indexPath(),
            ...(this.openError ? { error: this.openError } : {}),
            docs: stats.docs,
            chunks: stats.chunks,
            chars: stats.chars,
            vectorized: stats.vectorized,
            refs: stats.refs,
            statuses: stats.statuses,
            indexBytes: stats.bytes,
            lastScan: this.lastScan
              ? { at: new Date(this.lastScan.at).toISOString(), ...this.lastScan, at: undefined }
              : null,
            lastQuery: this.lastQuery || null,
            lastRecall: {
              at: this.lastRecall.at ? new Date(this.lastRecall.at).toISOString() : null,
              query: this.lastRecall.query,
              paths: this.lastRecall.paths,
              tokens: this.lastRecall.tokens,
              ms: this.lastRecall.ms,
            },
            config: {
              topK: this.topK(),
              budgetTokens: this.budgetTokens(),
              inject: this.cfg?.inject !== false,
              vector: this.cfg?.vector ?? 'auto',
              scanSeconds: Number(this.cfg?.scanSeconds) || 30,
            },
          }))
        },
      },
    ]
  }

  // ------------------------------------------------------------ WebUI

  /** 面板 + 配置 + 可清除的索引 + 提示词模板声明。 */
  webUi(language = 'zh') {
    const zh = !String(language ?? '').toLowerCase().startsWith('en')
    const stats = this.stats()
    const workspace = this.workspace()
    const exists = existsSync(workspace)
    const engineLabel = this.engine === 'sqlite'
      ? (this.embedKind === 'onnx' ? 'SQLite FTS5 + ONNX' : this.embedKind === 'builtin' ? 'SQLite FTS5 + 本地向量' : 'SQLite FTS5')
      : this.engine === 'grep' ? (zh ? 'grep 兜底' : 'grep fallback') : (zh ? '未就绪' : 'not ready')

    return {
      label: zh ? '记忆检索' : 'Memory recall',
      lamps: [{
        label: zh ? '索引' : 'Index',
        state: !exists ? 'error' : this.engine === 'grep' ? 'loading' : this.engine === 'sqlite' ? 'online' : 'offline',
        hint: !exists
          ? (zh ? `工作区不存在：${workspace}` : `Workspace missing: ${workspace}`)
          : this.engine === 'grep'
            ? (zh ? `索引不可用，正在用 grep 兜底：${this.openError}` : `Index unavailable, falling back to grep: ${this.openError}`)
            : `${engineLabel} · ${this.indexPath()}`,
      }],
      badges: [
        { label: zh ? '笔记' : 'Notes', value: stats.docs, tone: 'plain' },
        { label: zh ? '段' : 'Chunks', value: stats.chunks, tone: 'plain' },
        { label: zh ? '本轮回调' : 'Recall', value: this.lastRecall.paths.length, tone: this.lastRecall.paths.length ? 'on' : 'off' },
      ],
      panels: [
        {
          id: 'index',
          title: zh ? '索引状态' : 'Index status',
          description: zh
            ? '索引了哪个目录、多少篇笔记、向量层是什么、上一轮自动注入了哪几条。'
            : 'Which folder is indexed, how many notes, which embedding layer, and what the last recall injected.',
          getMethods: ['status'],
        },
        {
          id: 'probe',
          title: zh ? '试检索' : 'Try a search',
          description: zh
            ? '直接跑一次检索，看会拿到哪几段——排「为什么它想不起来」用。'
            : 'Run one search and see which chunks come back; use it to debug why a memory is missed.',
        },
      ],
      promptDocs: [{
        key: 'worlds.memory.envPrompt',
        title: zh ? '记忆检索环境提示词' : 'Memory env prompt',
        description: zh
          ? '告诉模型这块记忆怎么用：什么时候搜、事实条目怎么写、注入了什么。'
          : 'How the model should use this index: when to search, how to write fact entries, what got injected.',
        path: ENV_PROMPT_FILE,
        role: 'envPrompt',
        vars: [
          { name: 'memory.recall', description: zh ? '本轮自动检索到的相关记忆（可能为空）' : 'Memories recalled for this round (may be empty)', multiline: true },
          { name: 'memory.workspace', description: zh ? '索引规模与引擎' : 'Index size and engine' },
        ],
      }],
      storage: [{
        key: 'index',
        label: zh ? '记忆索引（memory.db）' : 'Memory index (memory.db)',
        kind: 'disk',
        location: this.indexPath(),
        note: zh
          ? '删掉后下次扫描从工作区重建，不改动工作区里的任何笔记。'
          : 'Deleting it rebuilds from the workspace on the next scan; notes are untouched.',
        stat: () => {
          const current = this.stats()
          const kb = Math.round((current.bytes || 0) / 1024)
          return zh ? `${current.docs} 篇 / ${current.chunks} 段 / ${kb} KB` : `${current.docs} docs / ${current.chunks} chunks / ${kb} KB`
        },
        clear: async () => {
          const removed = existsSync(this.indexPath())
          try {
            this.store?.close()
          } catch {
            // 关不掉也要继续删。
          }
          this.store = null
          this.ready = null
          this.engine = 'none'
          this.openError = ''
          this.lastScanAt = 0
          this.cache.reset()
          const { rm } = await import('node:fs/promises')
          await rm(this.indexPath(), { force: true })
          await rm(`${this.indexPath()}-wal`, { force: true })
          await rm(`${this.indexPath()}-shm`, { force: true })
          return zh
            ? (removed ? '索引已删除，下次检索会重建' : '索引本来就不存在')
            : (removed ? 'Index deleted; it rebuilds on the next search' : 'There was no index to delete')
        },
      }],
      config: [{
        id: 'world:memory.main',
        owner: 'world:memory',
        schema: {
          type: 'object',
          title: zh ? '记忆检索' : 'Memory recall',
          description: zh
            ? '索引哪个目录、每轮注几条、向量层怎么算。改完立刻生效（索引路径和向量层除外）。'
            : 'Which folder to index, how many items per round, how vectors are computed.',
          properties: {
            'worlds.memory.workspace': {
              type: 'string',
              title: zh ? '索引目录' : 'Workspace to index',
              description: zh ? '留空 = Coopanion 的工作区（<部署>/workspace）。' : 'Empty = the deployment workspace.',
            },
            'worlds.memory.inject': {
              type: 'boolean',
              title: zh ? '每轮自动注入' : 'Auto-inject each round',
              description: zh ? '在前缀里塞「相关记忆」；关掉后只能手动 memory_search。' : 'Puts recalled notes into the prefix; off = search only.',
              'x-hot': true,
            },
            'worlds.memory.topK': {
              type: 'integer',
              title: zh ? '每轮注入几条' : 'Items per round',
              description: zh ? '1–20，默认 5。' : '1–20, default 5.',
              'x-hot': true,
            },
            'worlds.memory.budgetTokens': {
              type: 'integer',
              title: zh ? '注入 token 上限' : 'Inject token budget',
              description: zh ? '硬上限，默认 2000。' : 'Hard cap, default 2000.',
            },
            'worlds.memory.minCoverage': {
              type: 'number',
              title: zh ? '最低相关度' : 'Minimum coverage',
              description: zh ? '0–1，默认 0.12；低于它的候选不进前缀。' : '0–1, default 0.12.',
            },
            'worlds.memory.halfLifeDays': {
              type: 'integer',
              title: zh ? '时间衰减半衰期（天）' : 'Decay half-life (days)',
              description: zh ? '默认 90；0 = 不按时间衰减。' : 'Default 90; 0 = no decay.',
            },
            'worlds.memory.refBoost': {
              type: 'number',
              title: zh ? '引用加成' : 'Citation boost',
              description: zh ? '30 天内每被引用一次加多少分，默认 0.3。' : 'Per citation in 30 days, default 0.3.',
            },
            'worlds.memory.maxAgeDays': {
              type: 'integer',
              title: zh ? '只搜这么多天内改过的' : 'Only notes newer than (days)',
              description: zh ? '0 = 不限。' : '0 = no limit.',
            },
            'worlds.memory.vector': {
              type: 'string',
              title: zh ? '向量层' : 'Embedding layer',
              description: zh ? 'auto（默认）= 内置本地向量；off = 只用全文。' : 'auto = built-in local vectors; off = text only.',
              enum: ['auto', 'off'],
            },
            'worlds.memory.embedModel': {
              type: 'string',
              title: zh ? 'ONNX 模型目录（可选）' : 'ONNX model folder (optional)',
              description: zh
                ? '放 model.onnx + vocab.txt；留空用内置哈希向量。装了 onnxruntime-node 才生效，不联网。'
                : 'model.onnx + vocab.txt; empty = built-in hashed vectors.',
            },
            'worlds.memory.scanSeconds': {
              type: 'integer',
              title: zh ? '后台扫描间隔（秒）' : 'Scan interval (s)',
              description: zh ? '默认 30；写文件后也会被监听触发。' : 'Default 30; file writes trigger it too.',
            },
            'worlds.memory.skipDirs': {
              type: 'string',
              title: zh ? '跳过目录' : 'Skip folders',
              description: zh ? '逗号分隔，默认跳过 .git / blobs / log / data / archive 等。' : 'Comma separated.',
            },
            'worlds.memory.queryHint': {
              type: 'string',
              title: zh ? '当前话题提示词' : 'Topic hint',
              description: zh ? '会拼进自动检索的 query，比如「杀戮尖塔 药水 牌组」。' : 'Appended to the automatic query.',
            },
          },
        },
      }],
      invoke: async (panel, method, args) => {
        const payload = args?.[0] ?? {}
        if (panel === 'index' && method === 'status') return this.panelStatus(zh)
        if (panel === 'probe' && method === 'search') {
          const query = String(payload.query ?? '').trim()
          if (!query) return { ok: false, message: zh ? 'query 不能为空' : 'query is required' }
          await this.ensureFresh({ budgetMs: 1500 })
          const hits = await this.search(query, { k: Number(payload.k) || Number(this.cfg?.probeK) || 5, budgetTokens: 2000 })
          return {
            ok: true,
            query,
            engine: this.engine,
            hits: hits.map((item) => ({
              path: item.path,
              title: item.title,
              snippet: item.snippet,
              score: item.score,
              coverage: item.coverage,
              updated: dayOf(item.updated),
              status: item.status,
            })),
          }
        }
        if (panel === 'index' && method === 'reindex') {
          const ready = await this.ensureReady()
          if (!ready) return { ok: false, message: this.openError || (zh ? '索引不可用' : 'index unavailable') }
          if (payload.reset === true) {
            this.store?.reset()
            this.cache.reset()
          }
          const result = await this.scan({ deadline: Date.now() + 20000 })
          return { ok: Boolean(result), engine: this.engine, ...(result ?? {}) }
        }
        throw new Error(`unknown panel/method: ${panel}/${method}`)
      },
    }
  }

  /** 面板用的状态快照（同步、不扫盘）。 */
  panelStatus(zh) {
    const stats = this.stats()
    const docs = this.store ? this.store.allDocs() : []
    const recent = [...docs]
      .sort((a, b) => (b.updatedAt ?? b.mtime ?? 0) - (a.updatedAt ?? a.mtime ?? 0))
      .slice(0, 8)
      .map((doc) => ({
        path: doc.path,
        title: doc.title,
        status: doc.status,
        chunks: doc.chunks,
        updated: dayOf(doc.updatedAt ?? doc.mtime),
        supersededBy: doc.supersededBy,
      }))
    let topCited = []
    try {
      topCited = this.store ? this.store.topCited(6) : []
    } catch {
      topCited = []
    }
    return {
      ok: true,
      engine: this.engine,
      embed: this.embedKind,
      workspace: this.workspace(),
      workspaceExists: existsSync(this.workspace()),
      index: this.indexPath(),
      error: this.openError || null,
      docs: stats.docs,
      chunks: stats.chunks,
      chars: stats.chars,
      vectorized: stats.vectorized,
      indexBytes: stats.bytes,
      statuses: stats.statuses,
      lastScan: this.lastScan ? { at: new Date(this.lastScan.at).toISOString(), ms: this.lastScan.ms, added: this.lastScan.added, updated: this.lastScan.updated, removed: this.lastScan.removed, truncated: this.lastScan.truncated } : null,
      lastQuery: this.lastQuery || '',
      lastRecall: {
        at: this.lastRecall.at ? new Date(this.lastRecall.at).toISOString() : null,
        query: this.lastRecall.query,
        paths: this.lastRecall.paths,
        tokens: this.lastRecall.tokens,
        ms: this.lastRecall.ms,
        text: this.lastRecall.text,
      },
      recent,
      topCited: topCited.map((item) => ({ path: item.path, count: item.count, last: item.last ? new Date(item.last).toISOString() : null })),
      build: WORLD_BUILD,
      zh,
    }
  }

  // ------------------------------------------------------------ 生命周期

  /**
   * 挂载：开索引、立刻扫一把（不阻塞 start，扫描在后台跑），
   * 然后开文件监听 + 定时增量。
   */
  async start(host) {
    this.host = host
    this.startedAt = Date.now()
    this.log('info', `[memory] world build ${WORLD_BUILD} · 工作区 ${this.workspace()}`)
    const exists = existsSync(this.workspace())
    if (!exists) {
      this.log('warn', `[memory] 工作区不存在：${this.workspace()}（检索会一直返回空）`)
    }
    // 后台开索引 + 首扫：start() 不该被几 MB 的索引拖住。
    void this.ensureReady().then((ready) => {
      if (!ready) return
      void this.scan({ deadline: Date.now() + 20000 })
    })
    this.startWatcher()
    this.startTimer()
  }

  /** 文件监听：写完笔记立刻增量（800ms 防抖，编辑器连续的写只算一次）。 */
  startWatcher() {
    if (this.watcher) return
    if (!existsSync(this.workspace())) return
    try {
      this.watcher = watch(this.workspace(), { recursive: true }, (eventType, filename) => {
        if (filename && !NOTE_FILE.test(String(filename))) return
        if (this.watchTimer) clearTimeout(this.watchTimer)
        this.watchTimer = setTimeout(() => {
          this.watchTimer = null
          void this.scan({ deadline: Date.now() + 5000 })
        }, 800)
        this.watchTimer.unref?.()
      })
      this.watcher.on?.('error', (error) => {
        this.log('warn', `[memory] 文件监听出错（不影响定时扫描）：${error instanceof Error ? error.message : String(error)}`)
      })
    } catch (error) {
      this.log('warn', `[memory] 起不了文件监听，只靠定时扫描：${error instanceof Error ? error.message : String(error)}`)
    }
  }

  startTimer() {
    if (this.scanTimer) clearInterval(this.scanTimer)
    const seconds = Math.max(5, Math.min(600, Number(this.cfg?.scanSeconds) || 30))
    this.scanTimer = setInterval(() => {
      void this.scan({ deadline: Date.now() + 10000 })
    }, seconds * 1000)
    this.scanTimer.unref?.()
  }

  async stop() {
    if (this.scanTimer) clearInterval(this.scanTimer)
    this.scanTimer = null
    if (this.watchTimer) clearTimeout(this.watchTimer)
    this.watchTimer = null
    try {
      this.watcher?.close?.()
    } catch {
      // 关不掉就算了。
    }
    this.watcher = null
    try {
      this.store?.close()
    } catch {
      // 同上。
    }
    this.store = null
    this.ready = null
    this.host = null
  }

  /** 前缀重载完成：下一轮注入要换一批（不重复注入同一批）。 */
  onHandoffEnded() {
    this.lastQueryAt = 0
  }

  /** 一轮结束：顺手把这一轮写下的笔记扫进索引，下一轮就能搜到。 */
  onTurnEnded() {
    if (Date.now() - this.lastScanAt < MIN_SCAN_INTERVAL_MS) return
    void this.scan({ deadline: Date.now() + 5000 })
  }
}

export const definition = {
  id: WORLD_ID,
  label: '记忆检索',
  defaults,
  describe: {
    tools: [
      {
        name: 'memory_search',
        description: '在自己的工作区笔记里检索（本地全文 + 本地向量，零 API 成本）。',
        parameters: {
          type: 'object',
          properties: {
            query: { type: 'string', description: '关键词或一句话' },
            k: { type: 'integer', description: '要几条（1–20）' },
            status: { type: 'string', description: 'active / unfinished / superseded / archived / any' },
            maxAgeDays: { type: 'integer', description: '只要这么多天内改过的；0 = 不限' },
            path: { type: 'string', description: '只在这个路径里搜' },
          },
          required: ['query'],
        },
        tags: ['read'],
        summary: { zh: '在工作区笔记里搜相关段落', en: 'Search the workspace notes for relevant chunks' },
      },
      {
        name: 'memory_index',
        description: '增量重建工作区记忆索引（按 mtime+hash，只重切改过的文件）。',
        parameters: {
          type: 'object',
          properties: { reset: { type: 'boolean', description: 'true = 从头重建' } },
        },
        tags: ['write'],
        summary: { zh: '增量重建记忆索引', en: 'Rebuild the memory index incrementally' },
      },
      {
        name: 'memory_status',
        description: '记忆索引状态：索引了哪个目录、多少篇/多少段、最近注入了什么。',
        parameters: { type: 'object', properties: {} },
        tags: ['read'],
        summary: { zh: '看索引规模与上次注入了什么', en: 'Index size and what the last recall injected' },
      },
    ],
    events: [],
  },
  create: (ctx) => new MemoryWorld({ ctx, cfg: ctx?.cfg ?? defaults() }),
}

export default definition
