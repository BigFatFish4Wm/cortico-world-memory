/**
 * 端到端测试：拿一个假的「工作区」跑完整条链路，验 spec 的每一条验收点。
 *
 *   node cortico-world-memory/test/run.mjs [--real]
 *
 * 默认用 tmp 目录里现造的语料（可重复、不依赖真实部署）；`--real` 把
 * worlds.memory.workspace 指到真实工作区，验验收点的最后一条。
 *
 * 全部断言失败会以非零码退出。
 */

import { mkdir, rm, writeFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { tmpdir } from 'node:os'

import definition from '../index.js'
import { chunkDocument } from '../lib/chunk.js'
import { applySupersedes, parseDocument, splitFrontmatter } from '../lib/frontmatter.js'
import { bagOf, cosine, embedBuiltin, tokenize, BUILTIN_DIM } from '../lib/embed.js'
import { buildQuery, messageTextOf, RecallCache, recentHumanMessages, renderRecall } from '../lib/recall.js'
import { searchMemory, filterForInject } from '../lib/search.js'
import { estimateTokens, likeTerms, queryTokens, coverageTerms, snippet } from '../lib/text.js'

let passed = 0
let failed = 0
const failures = []

function check(name, condition, detail = '') {
  if (condition) {
    passed += 1
    console.log(`  ✓ ${name}`)
    return
  }
  failed += 1
  failures.push(`${name}${detail ? ` — ${detail}` : ''}`)
  console.log(`  ✗ ${name}${detail ? ` — ${detail}` : ''}`)
}

function section(title) {
  console.log(`\n## ${title}`)
}

// ---------------------------------------------------------------- 语料

const CORPUS = {
  'PARTNER.md': `---
updated: 2026-10-20
status: active
---

# 搭档

- 每天 token 上限 5 元，超了就没法说话，所以别乱调外部模型。
- 他喜欢先给结论再给细节。
`,
  'notes/pwa-run-state.md': `# PwA 当前这一局（2026-10-30 13:3x）

上一局（死在第 15 层）已废。重开了新局，**我打完又死了**。

- 结局：GAME_OVER，\`phase:waiting\`。
- 这局的药水只有敏捷药水，血 47/80，钱 0（被事件扣光了），牌组 11 张。
- 14:0x 第三局：药水只剩液态记忆，遗物有燃烧之血、轰鸣海螺。

## 第 15 层

- 清完一窝史莱姆，hp 29/91，金币 324。药水：液态记忆、易伤药水、能量药水。
- 奖励界面剩一张卡牌还没领（刚领了能量药水）。
`,
  'notes/cet6-plan-2026-12-12.md': `# 六级计划（2026-12-12 考）

单词在「不背单词」上，每天 50 个；听力每天一篇真题，写作每周两篇。
`,
  'notes/old-potion-rule.md': `---
updated: 2026-09-01
status: superseded
supersedes:
---

# 旧药水规则

血少的时候先喝药水再说（这条已经不对了）。
`,
  'notes/new-potion-rule.md': `---
updated: 2026-10-28
status: active
supersedes: notes/old-potion-rule.md
---

# 药水规则（新）

药水留到 boss 战；普通战斗血少也别急着喝。
`,
  'notes/secret-archive.md': `---
status: archived
---

# 归档的东西

这里写着药水的旧结论，但已经归档，不该再被检索出来。
`,
  'notes/unfinished-plan.md': `---
status: unfinished
updated: 2026-10-29
---

# 还没做完的计划

把 PwA 的地图投票接进去，顺便写一篇笔记说明药水怎么分配。
`,
}

async function makeWorkspace() {
  const root = join(tmpdir(), `cwm-test-${process.pid}-${Date.now()}`)
  for (const [path, body] of Object.entries(CORPUS)) {
    const abs = join(root, path)
    await mkdir(resolve(abs, '..'), { recursive: true })
    await writeFile(abs, body, 'utf8')
  }
  return root
}

/** 造一个最小 World 实例（不走 start，直接喂 ctx/cfg）。 */
function makeWorld({ workspace, indexFile }) {
  const cfg = { ...definition.defaults(), enabled: true, workspace, indexPath: indexFile, inject: true }
  const ctx = { id: 'memory', cfg, botDir: resolve(workspace, '..'), dataDir: resolve(workspace, '..', 'data') }
  const world = definition.create(ctx)
  return world
}

/** 假宿主：只要事件库和 log —— query 推导走的就是这两样。 */
function fakeHost(events = []) {
  return {
    log: { info() {}, warn() {}, error() {} },
    pushEvent: async () => ({}),
    store: {
      latestCursor: () => (events.length ? 1000 : 0),
      range: ({ limit } = {}) => (limit ? events.slice(-limit) : events),
    },
  }
}

/** 一句人话，用来验「按最近聊的话题自动检索」。 */
const HUMAN_EVENTS = [
  { source: 'desktop-pet', type: 'desktop-pet.touch', text: '[15:43] [touch] 阿梦戳了你 2 下' },
  { source: 'desktop-pet', type: 'desktop-pet.message', text: '[15:44] [typed] 阿梦:我上次说的药水还剩几瓶来着' },
  { source: 'pwa', type: 'pwa.turn_started', text: '轮到你了：第 3 回合（COMBAT）' },
]

// ---------------------------------------------------------------- 纯函数

function testText() {
  section('text：分词、预算、片段')

  check('CJK 识别', estimateTokens('药水') >= 2, `估成了 ${estimateTokens('药水')}`)
  check('英文按 3.5 字符 1 token', estimateTokens('abcdefg') === 2, `估成了 ${estimateTokens('abcdefg')}`)

  const tokens = queryTokens('我上次说的药水还剩几瓶')
  check('长中文查询拆成三字滑窗', tokens.includes('药水还') || tokens.includes('的药水'), tokens.join(','))
  check('滑窗都是 3 字', tokens.every((token) => token.length === 3))

  const short = likeTerms('药水还剩几瓶')
  check('LIKE 兜底拿到两字词', short.includes('药水'), short.join(','))
  check('LIKE 兜底不超过上限', short.length <= 8)

  const terms = coverageTerms('药水还剩几瓶')
  check('覆盖率词是二元组', terms.includes('药水') && terms.includes('还剩'), terms.join(','))

  const body = '前面一大段无关的话。'.repeat(10) + '这局的药水只有敏捷药水，血 47/80。' + '后面又是废话。'.repeat(10)
  const cut = snippet(body, ['药水'], { radius: 20 })
  check('片段落在命中词附近', cut.includes('药水只有'), cut)
  check('片段带省略号', cut.startsWith('…') && cut.endsWith('…'), cut)
  check('片段里没有换行', !cut.includes('\n'))
}

function testChunk() {
  section('chunk：300–800 字、按标题切')

  const long = `# 标题\n\n${'第一段。'.repeat(200)}\n\n## 小节\n\n${'第二段。'.repeat(50)}`
  const chunks = chunkDocument(long, { title: '标题' })
  check('切出了多段', chunks.length >= 2, `切出 ${chunks.length} 段`)
  check('段号从 0 连续', chunks.every((chunk, index) => chunk.chunk_no === index))
  check('除了最后一段都不超过上限', chunks.slice(0, -1).every((chunk) => chunk.chars <= 800 + 200), chunks.map((chunk) => chunk.chars).join(','))
  check('chunk 标题带上了小节名', chunks.some((chunk) => chunk.title.includes('小节')), chunks.map((chunk) => chunk.title).join(' | '))

  const tiny = chunkDocument('# 只有标题\n\n短。', { title: 't' })
  check('太短的正文不进索引', tiny.length === 0, JSON.stringify(tiny))

  const fenced = chunkDocument('```js\nconst a = 1\n\nconst b = 2\n```\n', { title: 'code' })
  check('代码块不被空行切开', fenced.length === 1 && fenced[0].body.includes('const b = 2'), JSON.stringify(fenced))

  const dup = chunkDocument(`# 同一标题\n\n${'内容。'.repeat(120)}`, { title: '同一标题' })
  check('一级标题不重复拼进 chunk 标题', dup[0].title === '同一标题', dup[0].title)
}

function testFrontmatter() {
  section('frontmatter：状态与推翻关系')

  const parsed = splitFrontmatter('---\nupdated: 2026-10-30\nstatus: active\ntags: [a, b]\n---\n正文')
  check('切出了头', parsed.hasFrontmatter && parsed.body.trim() === '正文', JSON.stringify(parsed.frontmatter))
  check('数组解析', Array.isArray(parsed.frontmatter.tags) && parsed.frontmatter.tags.length === 2, JSON.stringify(parsed.frontmatter.tags))

  const doc = parseDocument('notes/x.md', '---\nstatus: active\nsupersedes: notes/old.md\ntags: a, b\n---\n# 标题\n\n正文', { mtime: Date.now() })
  check('status 读出来了', doc.status === 'active')
  check('supersedes 读成数组', doc.supersedes[0] === 'notes/old.md', JSON.stringify(doc.supersedes))
  check('标题取第一个 # 标题', doc.title === '标题', doc.title)
  check('wikilink 抽出来', parseDocument('a.md', '见 [[notes/b.md]] 和 [[c|别名]]').links.join(',') === 'notes/b.md,c')

  const docs = [
    { path: 'notes/old.md', status: 'active', effectiveStatus: 'active', supersedes: [], supersededBy: [] },
    { path: 'notes/new.md', status: 'active', effectiveStatus: 'active', supersedes: ['notes/old.md'], supersededBy: [] },
  ]
  const changed = applySupersedes(docs)
  check('supersedes 把旧条目压成 superseded', docs[0].effectiveStatus === 'superseded', JSON.stringify(docs[0]))
  check('旧条目记下了谁推翻它', docs[0].supersededBy[0] === 'notes/new.md')
  check('改动计数', changed === 1, String(changed))

  const missing = splitFrontmatter('---\n没闭合的头\n正文')
  check('没闭合的头当正文', !missing.hasFrontmatter && missing.body.includes('没闭合'), JSON.stringify(missing.body))
}

function testEmbed() {
  section('embed：本地向量与 RRF 的输入')

  const near = cosine(embedBuiltin('药水还剩几瓶'), embedBuiltin('药水只有敏捷药水'))
  const far = cosine(embedBuiltin('药水还剩几瓶'), embedBuiltin('六级单词每天五十个'))
  check('字面重叠的向量更近', near > far, `${near.toFixed(3)} vs ${far.toFixed(3)}`)
  check('自己的余弦是 1', Math.abs(cosine(embedBuiltin('abc'), embedBuiltin('abc')) - 1) < 1e-6)
  check('维度对得上', embedBuiltin('x').length === BUILTIN_DIM)
  check('空文本不炸', embedBuiltin('').length === BUILTIN_DIM)
  check('词袋非空', bagOf('药水 potion').length > 2)

  const vocab = new Map([['[CLS]', 1], ['[SEP]', 2], ['[UNK]', 3], ['药', 4], ['水', 5], ['po', 6], ['##tion', 7]])
  const ids = tokenize('药水 potion', vocab, 32)
  check('WordPiece 切成 [CLS] … [SEP]', ids[0] === 1 && ids[ids.length - 1] === 2, ids.join(','))
  check('中文按单字', ids.includes(4) && ids.includes(5), ids.join(','))
  check('英文按词片段', ids.includes(6) && ids.includes(7), ids.join(','))
}

// ---------------------------------------------------------------- 世界链路

async function testWorld() {
  section('world：索引 → 检索 → 注入 → 去重')

  const workspace = await makeWorkspace()
  const indexFile = join(workspace, '.index', 'memory.db')
  const world = makeWorld({ workspace, indexFile })
  await world.start(fakeHost(HUMAN_EVENTS))

  try {
    const ready = await world.ensureReady()
    check('索引打开成功（node:sqlite）', ready && world.engine === 'sqlite', world.openError)

    const scanned = await world.scan({ deadline: Date.now() + 20000 })
    check('首扫索引了全部笔记', scanned && scanned.docs === Object.keys(CORPUS).length, JSON.stringify(scanned))
    check('索引里有段', scanned.chunks >= scanned.docs, JSON.stringify(scanned))
    check('索引文件落盘', existsSync(indexFile))

    // 验收点：问「我上次说的药水还剩几瓶」要命中 pwa-run-state。
    const hits = await world.search('我上次说的药水还剩几瓶')
    check('药水问题命中了 pwa-run-state', hits.some((hit) => hit.path.includes('pwa-run-state')), hits.map((hit) => `${hit.path}:${hit.score}`).join(', '))
    check('命中的片段里有药水', hits[0]?.snippet.includes('药水'), hits[0]?.snippet)

    const archived = await world.search('药水')
    check('archived 的不返回', !archived.some((hit) => hit.path.includes('secret-archive')), archived.map((hit) => hit.path).join(','))

    const superseded = await world.search('旧药水规则')
    check('被 superseded 的不返回', !superseded.some((hit) => hit.path.includes('old-potion-rule')), superseded.map((hit) => hit.path).join(','))
    const withOld = await world.search('旧药水规则', { status: 'superseded' })
    check('status=superseded 能翻出来', withOld.some((hit) => hit.path.includes('old-potion-rule')), withOld.map((hit) => hit.path).join(','))

    const unfinished = await world.search('地图投票', { status: 'unfinished' })
    check('status=unfinished 能只挑未完成', unfinished.length > 0 && unfinished.every((hit) => hit.status === 'unfinished'), unfinished.map((hit) => `${hit.path}:${hit.status}`).join(','))

    const perFile = await world.search('药水')
    const counts = new Map()
    for (const hit of perFile) counts.set(hit.path, (counts.get(hit.path) ?? 0) + 1)
    check('一个文件最多出现一次（按 path 去重）', [...counts.values()].every((n) => n === 1), JSON.stringify([...counts]))

    // 注入
    const recall = await world.buildRecall()
    const tokens = estimateTokens(recall)
    check('注入非空', Boolean(recall), recall)
    check('注入是 spec 的格式', /^- \[\[.+\]\] .+（\d{4}-\d{2}-\d{2}）$/m.test(recall.split('\n')[0]), recall.split('\n')[0])
    check('注入总量在上限内', tokens <= 2000, `${tokens} tokens`)

    const second = await world.buildRecall()
    const firstPaths = [...recall.matchAll(/\[\[([^\]]+)\]\]/g)].map((match) => match[1])
    const secondPaths = [...second.matchAll(/\[\[([^\]]+)\]\]/g)].map((match) => match[1])
    check('连续两轮不重复注入同一批', secondPaths.every((path) => !firstPaths.includes(path)) || secondPaths.length === 0,
      `${firstPaths.join(',')} → ${secondPaths.join(',')}`)

    // envPromptVars
    const vars = await world.envPromptVars()
    check('envPromptVars 给出 memory.recall', vars && typeof vars['memory.recall'] === 'string', JSON.stringify(vars))
    check('envPromptVars 给出 memory.workspace', vars && typeof vars['memory.workspace'] === 'string')

    // 工具
    const tools = world.tools()
    check('工具齐全', ['memory_search', 'memory_index', 'memory_status'].every((name) => tools.some((tool) => tool.name === name)), tools.map((tool) => tool.name).join(','))
    check('工具名带前缀、有 tags', tools.every((tool) => /^[a-z0-9]+_/.test(tool.name) && Array.isArray(tool.tags)))

    const searchTool = tools.find((tool) => tool.name === 'memory_search')
    const reply = JSON.parse(await searchTool.handler({ query: '药水还剩几瓶', k: 3 }))
    check('memory_search 回执是 JSON', reply.ok === true && Array.isArray(reply.hits), JSON.stringify(reply).slice(0, 200))
    check('memory_search 命中', reply.hits.length > 0, JSON.stringify(reply))

    const statusTool = tools.find((tool) => tool.name === 'memory_status')
    const status = JSON.parse(await statusTool.handler({}))
    check('memory_status 报告引擎与规模', status.engine === 'sqlite' && status.docs === Object.keys(CORPUS).length, JSON.stringify(status).slice(0, 300))

    // 增量：改一个文件
    await writeFile(join(workspace, 'notes/new-note.md'), '---\nstatus: active\n---\n\n# 新笔记\n\n关于药水的第三条结论：药水别在商店买，太贵了。\n', 'utf8')
    const again = await world.scan({ deadline: Date.now() + 20000 })
    check('增量扫描只加了一个', again.added === 1 && again.updated === 0, JSON.stringify(again))
    const fresh = await world.search('药水别在商店买')
    check('新文件马上能搜到', fresh.some((hit) => hit.path.includes('new-note')), fresh.map((hit) => hit.path).join(','))

    // 删文件
    await rm(join(workspace, 'notes/new-note.md'))
    const afterDelete = await world.scan({ deadline: Date.now() + 20000 })
    check('删掉的文件从索引里消失', afterDelete.removed === 1, JSON.stringify(afterDelete))

    // 写文件后不扫描也能靠 ensureFresh 跟上（3 秒节流）
    world.lastScanAt = 0
    await writeFile(join(workspace, 'notes/after-idle.md'), '# 空档期\n\n这期间我写了关于药水冷却的笔记。\n', 'utf8')
    await world.ensureFresh({ budgetMs: 5000 })
    const idle = await world.search('药水冷却')
    check('ensureFresh 能补上漏掉的改动', idle.some((hit) => hit.path.includes('after-idle')), idle.map((hit) => hit.path).join(','))

    // 预算：把 k 和预算都压到很小
    const tight = await world.search('药水', { k: 8, budgetTokens: 20 })
    check('预算能压住条数', tight.length === 1, `${tight.length} 条`)

    // 面板 / 存储
    const ui = world.webUi('zh')
    check('webUi 声明了两个面板', ui.panels.length === 2 && ui.panels.every((panel) => /^[a-z0-9-]+$/.test(panel.id)), JSON.stringify(ui.panels.map((panel) => panel.id)))
    check('webUi 有配置组且路径在 worlds.memory.*', ui.config[0].owner === 'world:memory' && Object.keys(ui.config[0].schema.properties).every((path) => path.startsWith('worlds.memory.')))
    check('配置项都有 defaults', Object.keys(ui.config[0].schema.properties).every((path) => definition.defaults()[path.slice('worlds.memory.'.length)] !== undefined))
    check('webUi 有可清除的索引存储', ui.storage.length === 1 && ui.storage[0].kind === 'disk' && typeof ui.storage[0].clear === 'function')

    const kv = await ui.invoke('index', 'status', [{}])
    check('面板 status 可调用', kv.ok === true && kv.docs >= Object.keys(CORPUS).length, JSON.stringify(kv).slice(0, 200))
    const probe = await ui.invoke('probe', 'search', [{ query: '六级单词' }])
    check('面板试检索可调用', probe.ok === true && probe.hits.length > 0, JSON.stringify(probe).slice(0, 200))

    // 清理索引
    const cleared = await ui.storage[0].clear()
    check('存储可清除', typeof cleared === 'string' && !existsSync(indexFile), cleared)
  } finally {
    await world.stop()
    await rm(workspace, { recursive: true, force: true })
  }
}

async function testRealWorkspace() {
  section('真实工作区：验收点')
  const real = process.argv.includes('--real')
  const target = process.env.MEMORY_WORKSPACE
    || 'D:\\Program Files\\coopanion\\data\\home\\companion\\workspace'
  if (!existsSync(target) || !existsSync(join(target, 'notes'))) {
    if (real) check(`真实工作区存在（${target}）`, false)
    else console.log(`  · 跳过（找不到 ${target}，用 --real 强制要求）`)
    return
  }
  const indexFile = join(tmpdir(), `cwm-real-${Date.now()}`, 'memory.db')
  const world = makeWorld({ workspace: target, indexFile })
  try {
    const started = Date.now()
    const scanned = await world.scan({ deadline: Date.now() + 120000 })
    check('真实工作区索引成功', scanned && scanned.docs > 20, JSON.stringify(scanned))
    console.log(`    · ${scanned.docs} 篇 / ${scanned.chunks} 段，用时 ${scanned.ms}ms（含向量）`)

    const queryStarted = Date.now()
    const hits = await world.search('我上次说的药水还剩几瓶')
    const elapsed = Date.now() - queryStarted
    check('药水问题命中 notes/pwa-run-state.md', hits.some((hit) => hit.path.includes('pwa-run-state')), hits.map((hit) => `${hit.path}(${hit.score})`).join(', '))
    check(`单次检索够快（${elapsed}ms < 800ms）`, elapsed < 800, `${elapsed}ms`)

    const recall = await world.buildRecall()
    check('真实工作区注入非空', Boolean(recall), '(空)')
    check('注入不超 2000 token', estimateTokens(recall) <= 2000, `${estimateTokens(recall)}`)

    // grep 能找到的，memory_search 必须能找到
    const needles = ['敏捷药水', '不背单词', 'token 上限']
    for (const needle of needles) {
      const found = await world.search(needle, { k: 5 })
      check(`grep 能找的「${needle}」也能检索到`, found.some((hit) => hit.snippet.includes(needle) || hit.title.includes(needle)),
        found.map((hit) => hit.path).join(',') || '(无命中)')
    }
  } finally {
    await world.stop()
    await rm(resolve(indexFile, '..'), { recursive: true, force: true })
  }
}

function testRecallHelpers() {
  section('recall：query 推导与去重缓存')

  check('剥掉投递标注', messageTextOf({ text: '[15:44] [typed] 阿梦:哦，所以一直没有唤醒' }) === '阿梦:哦，所以一直没有唤醒')
  check('回执不当话题', messageTextOf({ text: '送达了 #21870' }) === '')
  check('系统帧不当话题', messageTextOf({ text: '[system] 2 new events.' }) === '')
  check('纯应答不当话题（ok）', messageTextOf({ text: '[15:55] [typed] 阿梦:ok' }) === '')
  check('纯应答不当话题（嗯嗯）', messageTextOf({ text: '阿梦:嗯嗯' }) === '')
  check('两个字的真话题照样算', messageTextOf({ text: '阿梦:六级' }) === '阿梦:六级', messageTextOf({ text: '阿梦:六级' }))

  const withAck = [
    { source: 'desktop-pet', type: 'desktop-pet.message', text: '[15:44] [typed] 阿梦:六级单词每天背多少' },
    { source: 'desktop-pet', type: 'desktop-pet.message', text: '[15:55] [typed] 阿梦:ok' },
  ]
  const afterAck = recentHumanMessages({ latestCursor: () => 10, range: () => withAck }, { worldId: 'memory' })
  check('应答被跳过，取到真正说了话的那条', afterAck.length === 1 && afterAck[0].includes('六级'), JSON.stringify(afterAck))

  const events = [
    { source: 'desktop-pet', type: 'desktop-pet.touch', text: '[15:43] [touch] 阿梦戳了你 2 下' },
    { source: 'desktop-pet', type: 'desktop-pet.message', text: '[15:44] [typed] 阿梦:药水还剩几瓶' },
    { source: 'qqbot', type: 'qq.message', text: '阿梦:顺便看看六级计划' },
    { source: 'memory', type: 'memory.recall', text: '不该被自己搜到自己' },
  ]
  const store = {
    latestCursor: () => 100,
    range: () => events,
  }
  const messages = recentHumanMessages(store, { worldId: 'memory' })
  check('只取最近两条人话', messages.length === 2, JSON.stringify(messages))
  check('噪声事件被过滤', messages.every((text) => !text.includes('戳了你')), JSON.stringify(messages))
  check('不把自己的事件当人话', messages.every((text) => !text.includes('不该被搜到')))

  const query = buildQuery({ messages, hint: '杀戮尖塔' })
  check('query 拼上了提示词', query.includes('药水') && query.includes('杀戮尖塔'), query)

  const fallback = buildQuery({ messages: [], hint: '', recentTitles: ['notes pwa run state'] })
  check('没消息时退到文件名', fallback === 'notes pwa run state', fallback)

  const cache = new RecallCache()
  const results = [{ path: 'a.md' }, { path: 'b.md' }, { path: 'c.md' }]
  const first = cache.pick(results, 2)
  cache.commit(first)
  const second = cache.pick(results, 2)
  check('下一轮换一批', second.every((item) => !first.some((old) => old.path === item.path)), `${first.map((i) => i.path)} → ${second.map((i) => i.path)}`)
  cache.commit(second)
  const third = cache.pick(results, 2)
  check('只剩旧的时候允许补', third.length === 2, JSON.stringify(third))

  const rendered = renderRecall([{ path: 'notes/x.md', snippet: '药水只有敏捷药水。', updated: Date.parse('2026-10-30T00:00:00Z'), status: 'active' }])
  check('渲染成 spec 的格式', /^- \[\[notes\/x\.md\]\] 药水只有敏捷药水。（2026-10-30）$/.test(rendered), rendered)
}

function testSearchEdge() {
  section('search：边界')

  check('空查询不炸', queryTokens('') .length === 0)
  check('只有标点的查询不炸', coverageTerms('，。！？').length === 0)
  const filtered = filterForInject([{ coverage: 0.5, path: 'a', score: 1 }, { coverage: 0.01, path: 'b', score: 2 }])
  check('低覆盖率进不了前缀', filtered.length === 1 && filtered[0].path === 'a')
  const tail = filterForInject([{ coverage: 0.5, path: 'a', score: 1 }, { coverage: 0.4, path: 'b', score: 0.1 }])
  check('明显比第一名差太多的被砍掉', tail.length === 1 && tail[0].path === 'a', JSON.stringify(tail))
}

// ---------------------------------------------------------------- 跑

console.log('记忆检索（cortico-world-memory）端到端测试')

testText()
testChunk()
testFrontmatter()
testEmbed()
testRecallHelpers()
testSearchEdge()
await testWorld()
await testRealWorkspace()

console.log(`\n${failed === 0 ? '✅' : '❌'} 通过 ${passed} / ${passed + failed}`)
if (failed) {
  console.log('失败项：')
  for (const failure of failures) console.log(`  - ${failure}`)
  process.exit(1)
}
