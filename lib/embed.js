/**
 * 本地 embedding：把一段文本压成一个归一化向量，用来做语义召回。
 *
 * 两条路，都不碰云端：
 *
 * 1. `builtin`（默认，零依赖）—— 字符 n-gram 哈希嵌入。中文取一/二/三元组，
 *    拉丁取整词，各自哈希到固定维度后加权累加、L2 归一化。它抓的是「字面重叠」，
 *    但对中文足够像「词袋」：`药水还剩几瓶` 会和 `药水只有敏捷药水` 因为共享
 *    `药水` 而靠近，而 FTS 的 trigram 在查询里逐字出现才命中，反而漏。两者
 *    互补正是 RRF 融合想要的效果。
 *
 * 2. `onnx`（可选）—— `onnxruntime-node` + 一个 BERT 类小模型
 *    （bge-small-zh-v1.5 / multilingual-e5-small）。模型和词表由使用者放进
 *    `<workspace>/.index/embed/`，或把 `worlds.memory.embedModel` 指到目录。
 *    装了才启用，没装就静默退回 builtin —— 不下载、不联网。
 *
 * 向量以 Float32 BLOB 存在 chunks.vec 里；改维度（换模型）时索引会整体重建。
 */

import { createHash } from 'node:crypto'
import { chars, isCjk } from './text.js'

/** builtin 的维度。256 维 × 4 字节 = 1KB/段，几千段也就几 MB。 */
export const BUILTIN_DIM = 256
export const EMBED_VERSION = 1

const NGRAM_WEIGHT = { 1: 0.45, 2: 1.0, 3: 0.8, word: 1.4 }
const WORD_RE = /[A-Za-z0-9_]+/g

/** FNV-1a 32 位：够均匀、够快、无依赖。 */
function fnv1a(text, seed = 0x811c9dc5) {
  let hash = seed >>> 0
  for (let i = 0; i < text.length; i += 1) {
    hash ^= text.charCodeAt(i)
    hash = Math.imul(hash, 0x01000193) >>> 0
  }
  return hash >>> 0
}

/** 加权的 n-gram 词袋：{ token, weight }[]。 */
export function bagOf(text) {
  const bag = []
  const source = String(text ?? '').toLowerCase()
  if (!source) return bag

  for (const match of source.matchAll(WORD_RE)) {
    const word = match[0]
    if (word.length < 2) continue
    bag.push({ token: `w:${word}`, weight: NGRAM_WEIGHT.word })
  }

  // 只在 CJK 串上切字级 n-gram：拉丁文本走整词，否则 `the` 会被切成上千个碎片。
  let run = []
  const flushRun = () => {
    if (!run.length) return
    for (let n = 1; n <= 3; n += 1) {
      for (let i = 0; i + n <= run.length; i += 1) {
        bag.push({ token: `c:${run.slice(i, i + n).join('')}`, weight: NGRAM_WEIGHT[n] })
      }
    }
    run = []
  }
  for (const ch of chars(source)) {
    if (isCjk(ch)) run.push(ch)
    else flushRun()
  }
  flushRun()
  return bag
}

/**
 * builtin 嵌入：哈希到 dim 维、带符号累加、L2 归一化。
 *
 * 符号位取自另一个哈希：不加符号会让所有向量落在一个正象限里，余弦相似度虚高。
 */
export function embedBuiltin(text, dim = BUILTIN_DIM) {
  const vector = new Float32Array(dim)
  for (const { token, weight } of bagOf(text)) {
    const at = fnv1a(token) % dim
    const sign = fnv1a(token, 0x9e3779b1) % 2 === 0 ? 1 : -1
    vector[at] += sign * weight
  }
  return l2Normalize(vector)
}

/** 原地 L2 归一化；全零向量原样返回。 */
export function l2Normalize(vector) {
  let sum = 0
  for (let i = 0; i < vector.length; i += 1) sum += vector[i] * vector[i]
  if (sum <= 0) return vector
  const scale = 1 / Math.sqrt(sum)
  for (let i = 0; i < vector.length; i += 1) vector[i] *= scale
  return vector
}

/** 两个已归一化向量的余弦（就是点积）。维度不同返回 0。 */
export function cosine(a, b) {
  if (!a || !b || a.length !== b.length) return 0
  let sum = 0
  for (let i = 0; i < a.length; i += 1) sum += a[i] * b[i]
  return sum
}

/** Float32Array → BLOB 用的 Buffer。 */
export function vectorToBuffer(vector) {
  return Buffer.from(vector.buffer, vector.byteOffset, vector.byteLength)
}

/** BLOB → Float32Array；空值返回 null。 */
export function bufferToVector(blob) {
  if (!blob) return null
  const bytes = Buffer.isBuffer(blob) ? blob : Buffer.from(blob)
  if (!bytes.length) return null
  // 复制一份，避免不同平台上的对齐问题。
  const copy = Buffer.from(bytes)
  return new Float32Array(copy.buffer, copy.byteOffset, Math.floor(copy.byteLength / 4))
}

/** 内容指纹：改过模型的输出就整体重建索引时用。 */
export function fingerprintOf(text) {
  return createHash('sha1').update(String(text ?? '')).digest('hex').slice(0, 16)
}

// ---------------------------------------------------------------- ONNX（可选）

/**
 * 建一个 ONNX embedder。
 *
 * 只有显式配置 `embedModel` 且目录里找得到模型与词表时才成功；任何一步失败都返回
 * { ok: false, reason }，调用方退回 builtin。这里不下载任何东西。
 */
export async function createOnnxEmbedder({ dir, modelFile = 'model.onnx', vocabFile = 'vocab.txt', dim, maxTokens = 256 } = {}) {
  if (!dir) return { ok: false, reason: '没有配置 embedModel 目录' }
  let ort
  try {
    ort = await import('onnxruntime-node')
  } catch {
    return { ok: false, reason: '没装 onnxruntime-node（可选依赖，装了就自动启用）' }
  }
  const { readFileSync, existsSync } = await import('node:fs')
  const { join } = await import('node:path')
  const modelPath = join(dir, modelFile)
  const vocabPath = join(dir, vocabFile)
  if (!existsSync(modelPath)) return { ok: false, reason: `找不到模型 ${modelPath}` }
  if (!existsSync(vocabPath)) return { ok: false, reason: `找不到词表 ${vocabPath}` }

  let session
  try {
    session = await ort.InferenceSession.create(modelPath, { intraOpNumThreads: 1 })
  } catch (error) {
    return { ok: false, reason: `加载模型失败：${error instanceof Error ? error.message : String(error)}` }
  }
  const vocab = loadVocab(readFileSync(vocabPath, 'utf8'))
  const inputNames = session.inputNames ?? []

  /** 跑一次前向，返回句向量（mean pooling + L2 归一化）。 */
  const embed = async (text) => {
    const ids = tokenize(String(text ?? ''), vocab, maxTokens)
    const big = BigInt64Array.from(ids.map((id) => BigInt(id)))
    const tensor = new ort.Tensor('int64', big, [1, ids.length])
    const feeds = {}
    const mask = new BigInt64Array(ids.length).fill(1n)
    for (const name of inputNames) {
      if (name === 'input_ids') feeds[name] = tensor
      else if (name === 'attention_mask') feeds[name] = new ort.Tensor('int64', mask, [1, ids.length])
      else if (name === 'token_type_ids') feeds[name] = new ort.Tensor('int64', new BigInt64Array(ids.length), [1, ids.length])
    }
    const output = await session.run(feeds)
    const first = output[Object.keys(output)[0]]
    const data = first.data
    const width = dim || first.dims?.[first.dims.length - 1] || BUILTIN_DIM
    const pooled = new Float32Array(width)
    const rows = Math.floor(data.length / width)
    for (let row = 0; row < rows; row += 1) {
      for (let col = 0; col < width; col += 1) pooled[col] += data[row * width + col] / rows
    }
    return l2Normalize(pooled)
  }

  return { ok: true, dim: dim || undefined, embed, kind: 'onnx' }
}

/** vocab.txt → Map(token → id)。 */
export function loadVocab(text) {
  const vocab = new Map()
  let id = 0
  for (const line of String(text ?? '').split('\n')) {
    vocab.set(line.replace(/\r$/, ''), id)
    id += 1
  }
  return vocab
}

/**
 * BERT WordPiece 分词（不依赖 tokenizers 库）。
 *
 * `[CLS] tokens [SEP]`，贪心最长匹配，未登录词退 `[UNK]`。中文按单字切
 * （bge-zh / e5 的词表就是单字 + 词片段），英文按词 + `##` 续片。
 */
export function tokenize(text, vocab, maxTokens = 256) {
  const cls = vocab.get('[CLS]') ?? 101
  const sep = vocab.get('[SEP]') ?? 102
  const unk = vocab.get('[UNK]') ?? 100
  const ids = [cls]
  const pieces = []
  const source = String(text ?? '').toLowerCase()

  for (const match of source.matchAll(/[\u3400-\u9fff\uf900-\ufaff]|[a-z0-9]+|[^\sa-z0-9\u3400-\u9fff\uf900-\ufaff]+/g)) {
    const piece = match[0]
    if (isCjk(piece[0])) {
      pieces.push(piece)
      continue
    }
    if (/^[a-z0-9]+$/.test(piece)) {
      let start = 0
      while (start < piece.length) {
        let end = piece.length
        let found = ''
        while (end > start) {
          const candidate = `${start === 0 ? '' : '##'}${piece.slice(start, end)}`
          if (vocab.has(candidate)) {
            found = candidate
            break
          }
          end -= 1
        }
        if (!found) {
          pieces.push(piece.slice(start))
          break
        }
        pieces.push(found)
        start = end
      }
      continue
    }
    pieces.push(piece)
  }

  for (const piece of pieces) {
    if (ids.length >= maxTokens - 1) break
    const id = vocab.get(piece)
    ids.push(id === undefined ? unk : id)
  }
  ids.push(sep)
  return ids
}
