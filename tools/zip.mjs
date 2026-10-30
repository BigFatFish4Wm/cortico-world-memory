/**
 * 最小 ZIP 打包器（零依赖）：DEFLATE 来自 node:zlib，CRC32 自己算。
 *
 * 只做「把一个目录写成一个 zip」这一件事，够 release 资产用。
 * 支持子目录、保留 mtime，不加密、不分卷。
 */
import { deflateRawSync } from 'node:zlib'
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join, relative } from 'node:path'

/** CRC32 查表（IEEE 802.3，zip 用的那个）。 */
const CRC_TABLE = (() => {
  const table = new Uint32Array(256)
  for (let i = 0; i < 256; i += 1) {
    let c = i
    for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
    table[i] = c >>> 0
  }
  return table
})()

export function crc32(buffer) {
  let crc = 0xffffffff
  for (let i = 0; i < buffer.length; i += 1) crc = CRC_TABLE[(crc ^ buffer[i]) & 0xff] ^ (crc >>> 8)
  return (crc ^ 0xffffffff) >>> 0
}

/** 递归列出文件（相对路径，正斜杠）。 */
export function walk(root, { skip = [/^\.git\//, /^node_modules\//, /^release\//] } = {}) {
  const out = []
  const visit = (dir) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const abs = join(dir, entry.name)
      const rel = relative(root, abs).replace(/\\/g, '/')
      if (skip.some((pattern) => pattern.test(rel))) continue
      if (entry.isDirectory()) visit(abs)
      else if (entry.isFile()) out.push(rel)
    }
  }
  visit(root)
  return out.sort()
}

/** 本地时间 → DOS 日期/时间（zip 的字段）。 */
function dosDateTime(date) {
  const year = Math.max(1980, date.getFullYear())
  return {
    time: (date.getHours() << 11) | (date.getMinutes() << 5) | Math.floor(date.getSeconds() / 2),
    date: ((year - 1980) << 9) | ((date.getMonth() + 1) << 5) | date.getDate(),
  }
}

/**
 * 把一个目录打成 zip。
 *
 * `prefix` 会作为 zip 内的顶层目录（解压得到 `prefix/...`）。
 * 返回 Buffer。
 */
export function zipDirectory(root, { prefix = '', skip } = {}) {
  const files = walk(root, skip ? { skip } : undefined)
  const chunks = []
  const central = []
  let offset = 0

  for (const rel of files) {
    const abs = join(root, rel)
    const stat = statSync(abs)
    const raw = readFileSync(abs)
    const deflated = deflateRawSync(raw, { level: 9 })
    // 压不动的（已经压缩过的）走 store，别白白变大。
    const useDeflate = deflated.length < raw.length
    const data = useDeflate ? deflated : raw
    const name = Buffer.from(prefix ? `${prefix}/${rel}` : rel, 'utf8')
    const { time, date } = dosDateTime(stat.mtime)
    const crc = crc32(raw)

    const local = Buffer.alloc(30)
    local.writeUInt32LE(0x04034b50, 0)
    local.writeUInt16LE(20, 4) // version needed
    local.writeUInt16LE(0x0800, 6) // UTF-8 文件名
    local.writeUInt16LE(useDeflate ? 8 : 0, 8)
    local.writeUInt16LE(time, 10)
    local.writeUInt16LE(date, 12)
    local.writeUInt32LE(crc, 14)
    local.writeUInt32LE(data.length, 18)
    local.writeUInt32LE(raw.length, 22)
    local.writeUInt16LE(name.length, 26)
    local.writeUInt16LE(0, 28)

    chunks.push(local, name, data)

    const entry = Buffer.alloc(46)
    entry.writeUInt32LE(0x02014b50, 0)
    entry.writeUInt16LE(20, 4) // version made by
    entry.writeUInt16LE(20, 6) // version needed
    entry.writeUInt16LE(0x0800, 8)
    entry.writeUInt16LE(useDeflate ? 8 : 0, 10)
    entry.writeUInt16LE(time, 12)
    entry.writeUInt16LE(date, 14)
    entry.writeUInt32LE(crc, 16)
    entry.writeUInt32LE(data.length, 20)
    entry.writeUInt32LE(raw.length, 24)
    entry.writeUInt16LE(name.length, 28)
    entry.writeUInt16LE(0, 30) // extra
    entry.writeUInt16LE(0, 32) // comment
    entry.writeUInt16LE(0, 34) // disk
    entry.writeUInt16LE(0, 36) // internal attrs
    entry.writeUInt32LE(0o100644 << 16 >>> 0, 38) // external attrs: 普通文件（<< 是有符号的，得再转回无符号）
    entry.writeUInt32LE(offset, 42)
    central.push(entry, name)

    offset += local.length + name.length + data.length
  }

  const centralBuffer = Buffer.concat(central)
  const end = Buffer.alloc(22)
  end.writeUInt32LE(0x06054b50, 0)
  end.writeUInt16LE(0, 4)
  end.writeUInt16LE(0, 6)
  end.writeUInt16LE(files.length, 8)
  end.writeUInt16LE(files.length, 10)
  end.writeUInt32LE(centralBuffer.length, 12)
  end.writeUInt32LE(offset, 16)
  end.writeUInt16LE(0, 20)

  return Buffer.concat([...chunks, centralBuffer, end])
}
