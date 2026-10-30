/**
 * 索引本体：`<workspace>/.index/memory.db`，SQLite + FTS5(trigram)。
 *
 * 用 Node 24 自带的 `node:sqlite`（Electron 44 里可用，SQLite 3.53），
 * 所以整条链路零 npm 依赖、零编译、零云端。拿不到它就 `{ ok:false }`，
 * 上层退回直接扫文件的 grep 行为（见 fallback.js），不报错、不打断对话。
 *
 * 表：
 *   docs      一篇笔记一行：路径、标题、mtime/size/hash、状态、关系、段数
 *   chunks    一个检索单位一行：段号、带上下文的小标题、正文、向量 BLOB
 *   docs_fts  FTS5 trigram 索引，rowid 就是 chunks.id
 *   refs      引用流水：哪个文件在什么时候被注入/被搜到过（算 30 天内引用数）
 *   meta      索引元信息：schema 版本、embedding 指纹、上次全量扫描时刻
 *
 * 索引随时可以删掉：下一次扫描从工作区重建，工作区里的文件一个不动。
 */

import { mkdirSync, existsSync, statSync } from 'node:fs'
import { dirname } from 'node:path'
import { bufferToVector, cosine, vectorToBuffer } from './embed.js'

export const SCHEMA_VERSION = 1

const DDL = [
  `CREATE TABLE IF NOT EXISTS meta (
     key TEXT PRIMARY KEY,
     value TEXT NOT NULL
   )`,
  `CREATE TABLE IF NOT EXISTS docs (
     path TEXT PRIMARY KEY,
     title TEXT NOT NULL DEFAULT '',
     mtime INTEGER NOT NULL DEFAULT 0,
     size INTEGER NOT NULL DEFAULT 0,
     hash TEXT NOT NULL DEFAULT '',
     declared_status TEXT NOT NULL DEFAULT 'active',
     status TEXT NOT NULL DEFAULT 'active',
     updated_at INTEGER,
     supersedes TEXT NOT NULL DEFAULT '[]',
     superseded_by TEXT NOT NULL DEFAULT '[]',
     tags TEXT NOT NULL DEFAULT '[]',
     links TEXT NOT NULL DEFAULT '[]',
     chunks INTEGER NOT NULL DEFAULT 0,
     indexed_at INTEGER NOT NULL DEFAULT 0,
     note TEXT NOT NULL DEFAULT ''
   )`,
  `CREATE INDEX IF NOT EXISTS docs_status ON docs(status)`,
  `CREATE TABLE IF NOT EXISTS chunks (
     id INTEGER PRIMARY KEY AUTOINCREMENT,
     path TEXT NOT NULL,
     chunk_no INTEGER NOT NULL,
     title TEXT NOT NULL DEFAULT '',
     body TEXT NOT NULL,
     chars INTEGER NOT NULL DEFAULT 0,
     vec BLOB
   )`,
  `CREATE UNIQUE INDEX IF NOT EXISTS chunks_path_no ON chunks(path, chunk_no)`,
  `CREATE TABLE IF NOT EXISTS refs (
     path TEXT NOT NULL,
     at INTEGER NOT NULL,
     kind TEXT NOT NULL
   )`,
  `CREATE INDEX IF NOT EXISTS refs_at ON refs(at)`,
  `CREATE INDEX IF NOT EXISTS refs_path ON refs(path)`,
]

const FTS_DDL = `CREATE VIRTUAL TABLE IF NOT EXISTS docs_fts USING fts5(
  path UNINDEXED, chunk UNINDEXED, title, body, tokenize='trigram'
)`

function json(value) {
  return JSON.stringify(value ?? [])
}

function parseList(text) {
  try {
    const value = JSON.parse(text)
    return Array.isArray(value) ? value : []
  } catch {
    return []
  }
}

/** 在事务里跑一段同步代码；出错回滚。 */
function tx(db, fn) {
  db.exec('BEGIN IMMEDIATE')
  try {
    const result = fn()
    db.exec('COMMIT')
    return result
  } catch (error) {
    try {
      db.exec('ROLLBACK')
    } catch {
      // 回滚失败没有补救办法，原始错误更重要。
    }
    throw error
  }
}

/**
 * 打开（必要时创建）索引。
 *
 * 返回 { ok: true, store } 或 { ok: false, reason }；后者不是异常，
 * 上层据此切到 grep 兜底。`recreate` 会先把旧文件删掉（索引损坏时的自愈路径）。
 */
export async function openStore({ file, recreate = false } = {}) {
  let DatabaseSync
  try {
    ({ DatabaseSync } = await import('node:sqlite'))
  } catch (error) {
    return { ok: false, reason: `这个运行时没有 node:sqlite：${error instanceof Error ? error.message : String(error)}` }
  }

  let db = null
  try {
    mkdirSync(dirname(file), { recursive: true })
    if (recreate && existsSync(file)) {
      const { rmSync } = await import('node:fs')
      for (const suffix of ['', '-wal', '-shm']) rmSync(`${file}${suffix}`, { force: true })
    }
    db = new DatabaseSync(file)
    db.exec('PRAGMA journal_mode = WAL')
    db.exec('PRAGMA synchronous = NORMAL')
    db.exec('PRAGMA temp_store = MEMORY')
    for (const statement of DDL) db.exec(statement)

    let fts = true
    try {
      db.exec(FTS_DDL)
    } catch (error) {
      // 没有 FTS5 或没有 trigram 分词的 SQLite：退成「只有 LIKE + 向量」。
      fts = false
      db.exec(`CREATE TABLE IF NOT EXISTS docs_fts_unavailable (at INTEGER)`)
      void error
    }

    const store = new Store(db, { file, fts })
    store.migrate()
    return { ok: true, store }
  } catch (error) {
    // 失败时把句柄关掉，否则 Windows 上文件会一直占着（删索引会 EBUSY）。
    try {
      db?.close()
    } catch {
      // 没开成 db 就没什么可关的。
    }
    return { ok: false, reason: `打开索引失败：${error instanceof Error ? error.message : String(error)}` }
  }
}

class Store {
  constructor(db, { file, fts }) {
    this.db = db
    this.file = file
    this.fts = fts
    this.dirtyVectors = true
    this.vectorCache = { ids: [], vectors: [], paths: [] }
    this.statements = new Map()
  }

  /** 一条语句只 prepare 一次；参数形状变了就换一条。 */
  prepare(sql) {
    let statement = this.statements.get(sql)
    if (!statement) {
      statement = this.db.prepare(sql)
      this.statements.set(sql, statement)
    }
    return statement
  }

  migrate() {
    const current = Number(this.getMeta('schema_version') ?? 0)
    if (current === SCHEMA_VERSION) return
    // 版本变了就清空重建：索引是派生物，丢了只是下次重建慢一点。
    this.reset()
    this.setMeta('schema_version', String(SCHEMA_VERSION))
  }

  getMeta(key) {
    try {
      return this.prepare('SELECT value FROM meta WHERE key = ?').get(key)?.value ?? null
    } catch {
      return null
    }
  }

  setMeta(key, value) {
    this.prepare('INSERT INTO meta(key, value) VALUES(?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value')
      .run(key, String(value))
  }

  /** 清空全部索引内容（不动工作区）。 */
  reset() {
    tx(this.db, () => {
      this.db.exec('DELETE FROM chunks')
      this.db.exec('DELETE FROM docs')
      this.db.exec('DELETE FROM refs')
      // contentless 表要 `delete-all`，普通 content 表直接 DELETE。
      if (this.fts) this.db.exec('DELETE FROM docs_fts')
    })
    this.dirtyVectors = true
  }

  // ------------------------------------------------------------ 读写文档

  /** 路径 → 已索引的摘要。扫描用它判断「要不要重读这个文件」。 */
  listDocs() {
    const rows = this.prepare('SELECT path, mtime, size, hash, status, declared_status, chunks FROM docs').all()
    const map = new Map()
    for (const row of rows) {
      map.set(row.path, {
        mtime: Number(row.mtime) || 0,
        size: Number(row.size) || 0,
        hash: row.hash,
        status: row.status,
        declaredStatus: row.declared_status,
        chunks: Number(row.chunks) || 0,
      })
    }
    return map
  }

  /** 全量文档（含状态与关系），给状态传播和诊断用。 */
  allDocs() {
    const rows = this.prepare('SELECT * FROM docs ORDER BY path').all()
    return rows.map((row) => ({
      path: row.path,
      title: row.title,
      mtime: Number(row.mtime) || 0,
      size: Number(row.size) || 0,
      hash: row.hash,
      declaredStatus: row.declared_status,
      status: row.status,
      updatedAt: row.updated_at == null ? null : Number(row.updated_at),
      supersedes: parseList(row.supersedes),
      supersededBy: parseList(row.superseded_by),
      tags: parseList(row.tags),
      links: parseList(row.links),
      chunks: Number(row.chunks) || 0,
      note: row.note,
    }))
  }

  docOf(path) {
    const row = this.prepare('SELECT * FROM docs WHERE path = ?').get(path)
    if (!row) return null
    return {
      path: row.path,
      title: row.title,
      mtime: Number(row.mtime) || 0,
      hash: row.hash,
      declaredStatus: row.declared_status,
      status: row.status,
      updatedAt: row.updated_at == null ? null : Number(row.updated_at),
      supersedes: parseList(row.supersedes),
      supersededBy: parseList(row.superseded_by),
      tags: parseList(row.tags),
      links: parseList(row.links),
      chunks: Number(row.chunks) || 0,
      note: row.note,
    }
  }

  /**
   * 写入（或整体替换）一篇笔记。
   *
   * `chunks` 是 chunkDocument 的输出，`vectors` 与之一一对应（没有向量就传 null）。
   * 同一个事务里删旧段、插新段、同步 FTS —— FTS 与 chunks 的 rowid 必须一致，
   * 所以先拿 autoincrement 的 id 再补 FTS 行。
   */
  upsertDoc(doc, chunks, vectors) {
    const now = Date.now()
    tx(this.db, () => {
      this.removeChunksOf(doc.path)
      const insertChunk = this.prepare(
        'INSERT INTO chunks(path, chunk_no, title, body, chars, vec) VALUES(?, ?, ?, ?, ?, ?)',
      )
      const insertFts = this.fts
        ? this.prepare('INSERT INTO docs_fts(rowid, path, chunk, title, body) VALUES(?, ?, ?, ?, ?)')
        : null
      const ids = []
      for (let i = 0; i < chunks.length; i += 1) {
        const chunk = chunks[i]
        const vector = vectors?.[i] ?? null
        const result = insertChunk.run(
          doc.path,
          chunk.chunk_no,
          chunk.title ?? '',
          chunk.body,
          chunk.chars ?? chunk.body.length,
          vector ? vectorToBuffer(vector) : null,
        )
        const id = Number(result.lastInsertRowid)
        ids.push(id)
        insertFts?.run(id, doc.path, chunk.chunk_no, chunk.title ?? '', chunk.body)
      }
      this.prepare(`INSERT INTO docs(
          path, title, mtime, size, hash, declared_status, status, updated_at,
          supersedes, superseded_by, tags, links, chunks, indexed_at, note
        ) VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(path) DO UPDATE SET
          title = excluded.title, mtime = excluded.mtime, size = excluded.size, hash = excluded.hash,
          declared_status = excluded.declared_status, status = excluded.status, updated_at = excluded.updated_at,
          supersedes = excluded.supersedes, superseded_by = excluded.superseded_by,
          tags = excluded.tags, links = excluded.links, chunks = excluded.chunks,
          indexed_at = excluded.indexed_at, note = excluded.note
      `).run(
        doc.path,
        doc.title ?? '',
        Number(doc.mtime) || 0,
        Number(doc.size) || 0,
        doc.hash ?? '',
        doc.declaredStatus ?? 'active',
        doc.status ?? 'active',
        doc.updatedAt ? new Date(doc.updatedAt).getTime() : null,
        json(doc.supersedes),
        json(doc.supersededBy),
        json(doc.tags),
        json(doc.links),
        chunks.length,
        now,
        doc.note ?? '',
      )
    })
    this.dirtyVectors = true
  }

  /** 只改状态（supersede 传播的第二趟）。 */
  setStatus(path, status, supersededBy) {
    this.prepare('UPDATE docs SET status = ?, superseded_by = ? WHERE path = ?')
      .run(status, json(supersededBy ?? []), path)
  }

  removeChunksOf(path) {
    const rows = this.prepare('SELECT id FROM chunks WHERE path = ?').all(path)
    for (const row of rows) {
      if (this.fts) this.prepare('DELETE FROM docs_fts WHERE rowid = ?').run(Number(row.id))
    }
    this.prepare('DELETE FROM chunks WHERE path = ?').run(path)
  }

  deleteDoc(path) {
    tx(this.db, () => {
      this.removeChunksOf(path)
      this.prepare('DELETE FROM docs WHERE path = ?').run(path)
      this.prepare('DELETE FROM refs WHERE path = ?').run(path)
    })
    this.dirtyVectors = true
  }

  // ------------------------------------------------------------ 召回

  /**
   * FTS5 MATCH：tokens 之间 OR。
   *
   * 返回 [{ id, bm }]（bm 是 bm25，越负越好，调用方按顺序当 rank 用）。
   * tokens 为空或 FTS 不可用时返回 []。
   */
  ftsSearch(tokens, { limit = 50 } = {}) {
    if (!this.fts || !tokens?.length) return []
    const query = tokens.map((token) => `"${String(token).replace(/"/g, '""')}"`).join(' OR ')
    try {
      const rows = this.prepare(
        'SELECT rowid AS id, bm25(docs_fts, 0.0, 0.0, 3.0, 1.0) AS bm FROM docs_fts WHERE docs_fts MATCH ? ORDER BY bm LIMIT ?',
      ).all(query, limit)
      return rows.map((row) => ({ id: Number(row.id), bm: Number(row.bm) || 0 }))
    } catch {
      // 查询串里有 FTS5 认不出的东西：当作没命中，别让一次检索失败。
      return []
    }
  }

  /**
   * LIKE 兜底：长度 < 3 的词 trigram 索引不到（spec 里点名的限制），
   * 中文两字词也常被 FTS 漏掉，所以再扫一遍原文。
   *
   * 一趟扫描把所有词都试了，按命中词数排序；返回 [{ id, path, hits }]。
   */
  likeSearch(terms, { limit = 40 } = {}) {
    const list = (terms ?? []).filter(Boolean)
    if (!list.length) return []
    const score = list.map(() => `(title LIKE ? ESCAPE '\\' OR body LIKE ? ESCAPE '\\')`).join(' + ')
    const params = []
    for (const term of list) {
      const pattern = `%${term.replace(/[%_]/g, (ch) => `\\${ch}`)}%`
      params.push(pattern, pattern)
    }
    const sql = `SELECT id, path, hits FROM (
        SELECT id AS id, path AS path, ${score} AS hits FROM chunks
      ) WHERE hits > 0 ORDER BY hits DESC, id DESC LIMIT ?`
    try {
      const rows = this.prepare(sql).all(...params, limit)
      return rows.map((row) => ({ id: Number(row.id), path: row.path, hits: Number(row.hits) || 0 }))
    } catch {
      return []
    }
  }

  /** 全量向量缓存：每次索引改动后重建一次，之后多次检索复用。 */
  vectorIndex() {
    if (!this.dirtyVectors) return this.vectorCache
    const rows = this.prepare('SELECT id, path, vec FROM chunks WHERE vec IS NOT NULL').all()
    const ids = []
    const paths = []
    const vectors = []
    for (const row of rows) {
      const vector = bufferToVector(row.vec)
      if (!vector) continue
      ids.push(Number(row.id))
      paths.push(row.path)
      vectors.push(vector)
    }
    this.vectorCache = { ids, vectors, paths, dim: vectors[0]?.length ?? 0 }
    this.dirtyVectors = false
    return this.vectorCache
  }

  /**
   * 向量召回：与 query 向量做余弦，取前 limit。
   *
   * 几千段 × 256 维的点积在毫秒级，不需要 ANN 索引；真要十万段再说。
   */
  vectorSearch(vector, { limit = 50 } = {}) {
    if (!vector) return []
    const index = this.vectorIndex()
    if (!index.ids.length) return []
    const scored = []
    for (let i = 0; i < index.ids.length; i += 1) {
      const similarity = cosine(vector, index.vectors[i])
      if (similarity > 0.02) scored.push({ id: index.ids[i], score: similarity })
    }
    scored.sort((a, b) => b.score - a.score)
    return scored.slice(0, limit)
  }

  /** 按 id 取段（含正文，用于覆盖率与片段）。 */
  chunksByIds(ids) {
    const list = [...new Set((ids ?? []).map(Number).filter((id) => Number.isFinite(id)))]
    if (!list.length) return new Map()
    const out = new Map()
    // 分批查，避开 SQLite 的变量上限（默认 32766，但别赌）。
    for (let start = 0; start < list.length; start += 500) {
      const batch = list.slice(start, start + 500)
      const placeholders = batch.map(() => '?').join(',')
      const rows = this.prepare(
        `SELECT id, path, chunk_no, title, body, chars FROM chunks WHERE id IN (${placeholders})`,
      ).all(...batch)
      for (const row of rows) {
        out.set(Number(row.id), {
          id: Number(row.id),
          path: row.path,
          chunkNo: Number(row.chunk_no) || 0,
          title: row.title,
          body: row.body,
          chars: Number(row.chars) || 0,
        })
      }
    }
    return out
  }

  // ------------------------------------------------------------ 引用计数

  /** 记一次「被引用」（注入进前缀或作为检索结果交出去）。 */
  recordRefs(paths, kind = 'inject', at = Date.now()) {
    const unique = [...new Set((paths ?? []).filter(Boolean))]
    if (!unique.length) return
    tx(this.db, () => {
      const statement = this.prepare('INSERT INTO refs(path, at, kind) VALUES(?, ?, ?)')
      for (const path of unique) statement.run(path, at, kind)
    })
  }

  /** since 之后每个文件被引用几次。 */
  refCounts(since) {
    const rows = this.prepare('SELECT path, COUNT(*) AS n FROM refs WHERE at >= ? GROUP BY path').all(since)
    const map = new Map()
    for (const row of rows) map.set(row.path, Number(row.n) || 0)
    return map
  }

  /** 被引用最多的文件（诊断面板用）。 */
  topCited(limit = 8) {
    const rows = this.prepare(
      'SELECT path, COUNT(*) AS n, MAX(at) AS last FROM refs GROUP BY path ORDER BY n DESC LIMIT ?',
    ).all(limit)
    return rows.map((row) => ({ path: row.path, count: Number(row.n) || 0, last: Number(row.last) || 0 }))
  }

  /** 清掉过期流水，表不会无限长。 */
  pruneRefs(before) {
    const result = this.prepare('DELETE FROM refs WHERE at < ?').run(before)
    return Number(result.changes) || 0
  }

  // ------------------------------------------------------------ 诊断 / 维护

  stats() {
    const docs = this.prepare('SELECT COUNT(*) AS n, COALESCE(SUM(chunks), 0) AS chunks FROM docs').get()
    const chunkRows = this.prepare('SELECT COUNT(*) AS n, COALESCE(SUM(chars), 0) AS chars FROM chunks').get()
    const statuses = this.prepare('SELECT status, COUNT(*) AS n FROM docs GROUP BY status').all()
    const vectors = this.prepare('SELECT COUNT(*) AS n FROM chunks WHERE vec IS NOT NULL').get()
    const refs = this.prepare('SELECT COUNT(*) AS n FROM refs').get()
    return {
      docs: Number(docs?.n) || 0,
      chunks: Number(chunkRows?.n) || 0,
      chars: Number(chunkRows?.chars) || 0,
      vectorized: Number(vectors?.n) || 0,
      refs: Number(refs?.n) || 0,
      statuses: Object.fromEntries(statuses.map((row) => [row.status, Number(row.n) || 0])),
    }
  }

  fileSize() {
    try {
      let total = statSync(this.file).size
      for (const suffix of ['-wal', '-shm']) {
        if (existsSync(`${this.file}${suffix}`)) total += statSync(`${this.file}${suffix}`).size
      }
      return total
    } catch {
      return 0
    }
  }

  /** 删掉索引文件本身（StoragePart.clear 用）。调用方负责先 close。 */
  close() {
    try {
      this.db.close()
    } catch {
      // 已经关了，或者进程在退出：不必再抛。
    }
    this.statements.clear()
  }
}
