/**
 * WebUI 的一半：两个面板。
 *
 *   index  索引状态 —— 引擎、目录、规模、上次扫描、上一轮注入了哪几条、最近改过的笔记
 *   probe  试检索 —— 输入一句话直接跑一次检索，看会拿到哪几段（排「为什么想不起来」用）
 *
 * 数据全部走 ctx.invoke(method, args) 回到 index.js 的 webUi().invoke；
 * 这里不自己算任何相关度，只负责显示。
 */

const TEXT = {
  zh: {
    indexTitle: '索引状态',
    indexDesc: '索引了哪个目录、多少篇笔记、向量层是什么、上一轮自动注入了哪几条。',
    probeTitle: '试检索',
    probePlaceholder: '例如：我上次说的药水还剩几瓶',
    engine: '引擎',
    embed: '向量层',
    workspace: '工作区',
    indexFile: '索引文件',
    docs: '笔记',
    chunks: '段',
    vectorized: '带向量',
    size: '索引大小',
    lastScan: '上次扫描',
    lastQuery: '上次 query',
    lastRecall: '上一轮注入',
    none: '还没有',
    missing: '目录不存在',
    search: '搜索',
    reindex: '增量重建',
    rebuild: '从头重建',
    working: '正在重建…',
    reindexed: '索引已更新',
    empty: '没有命中',
    path: '文件',
    coverage: '相关度',
    score: '分数',
    snippet: '片段',
    recent: '最近改过的',
    cited: '最近常被引用',
    status: '状态',
    updated: '更新',
    confirmReset: '丢掉现有索引从头建？工作区里的笔记不会被改动。',
    noIndex: '索引不可用，检索退回 grep 兜底',
    tokens: 'token',
    seconds: '秒',
    scanSummary: (r) => `+${r.added} ~${r.updated} -${r.removed}，用时 ${r.ms} ms`,
  },
  en: {
    indexTitle: 'Index status',
    indexDesc: 'Which folder is indexed, how many notes, which embedding layer, and what the last recall injected.',
    probeTitle: 'Try a search',
    probePlaceholder: 'e.g. how many potions did I say I had left',
    engine: 'Engine',
    embed: 'Embedding',
    workspace: 'Folder',
    indexFile: 'Index file',
    docs: 'Notes',
    chunks: 'Chunks',
    vectorized: 'Vectorized',
    size: 'Index size',
    lastScan: 'Last scan',
    lastQuery: 'Last query',
    lastRecall: 'Last recall',
    none: 'nothing yet',
    missing: 'folder missing',
    search: 'Search',
    reindex: 'Reindex',
    rebuild: 'Rebuild',
    working: 'Rebuilding…',
    reindexed: 'Index updated',
    empty: 'No hits',
    path: 'File',
    coverage: 'Coverage',
    score: 'Score',
    snippet: 'Snippet',
    recent: 'Recently changed',
    cited: 'Most cited',
    status: 'Status',
    updated: 'Updated',
    confirmReset: 'Throw away the index and rebuild it from scratch? Notes are untouched.',
    noIndex: 'Index unavailable; searching falls back to grep',
    tokens: 'tokens',
    seconds: 's',
    scanSummary: (r) => `+${r.added} ~${r.updated} -${r.removed} in ${r.ms} ms`,
  },
}

const pick = (language) => (String(language || '').toLowerCase().startsWith('en') ? TEXT.en : TEXT.zh)

function bytes(value) {
  const n = Number(value) || 0
  if (n < 1024) return `${n} B`
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(0)} KB`
  return `${(n / 1024 / 1024).toFixed(1)} MB`
}

function stamp(iso) {
  if (!iso) return '—'
  try {
    return new Date(iso).toLocaleString([], { hour12: false })
  } catch {
    return String(iso)
  }
}

/** 索引状态面板。 */
const indexPanel = {
  async mount(ctx) {
    const t = pick(ctx.language)
    const sheet = ctx.ui.sheet({ title: t.indexTitle, desc: t.indexDesc })
    const bar = ctx.ui.rowbar()
    const kvBox = ctx.ui.h('div')
    const message = ctx.ui.msgline('')
    const actions = ctx.ui.actions()
    const reindex = ctx.ui.button(t.reindex, { variant: 'primary', size: 'sm' })
    const rebuild = ctx.ui.button(t.rebuild, { variant: 'danger', size: 'sm' })
    actions.append(ctx.ui.h('span', 'grow'), rebuild, reindex)

    const recent = ctx.ui.table({ head: [t.path, t.status, t.chunks, t.updated], maxHeight: '220px' })
    const cited = ctx.ui.table({ head: [t.path, t.chunks], maxHeight: '160px' })
    const recall = ctx.ui.h('div')
    recall.style.whiteSpace = 'pre-wrap'
    recall.style.fontFamily = 'monospace'
    recall.style.fontSize = '12px'
    recall.style.opacity = '.85'

    sheet.body.append(bar, kvBox, actions, message, ctx.ui.section(t.lastRecall), recall, ctx.ui.section(t.recent), recent.el, ctx.ui.section(t.cited), cited.el)
    ctx.root.appendChild(sheet.el)

    const render = (data) => {
      if (ctx.signal.aborted || !data) return
      bar.replaceChildren(
        ctx.ui.chip(`${data.engine ?? '—'}`, data.engine === 'sqlite' ? 'accent' : 'warn'),
        ctx.ui.chip(`${t.embed}: ${data.embed ?? '—'}`, 'muted'),
        ctx.ui.chip(`${data.docs} ${t.docs} / ${data.chunks} ${t.chunks}`, 'plain'),
        ctx.ui.chip(bytes(data.indexBytes), 'muted'),
      )
      kvBox.replaceChildren(ctx.ui.kv([
        { k: t.engine, v: data.engine === 'sqlite' ? `SQLite FTS5 · ${data.embed}` : data.engine === 'grep' ? (data.error || t.noIndex) : '—' },
        { k: t.workspace, v: data.workspaceExists ? data.workspace : `${data.workspace}（${t.missing}）` },
        { k: t.indexFile, v: data.index || '—' },
        { k: t.size, v: `${bytes(data.indexBytes)} · ${data.vectorized} ${t.vectorized}` },
        { k: t.lastScan, v: data.lastScan ? `${stamp(data.lastScan.at)} · ${data.lastScan.ms} ms` : t.none },
        { k: t.lastQuery, v: data.lastQuery || t.none },
        { k: 'recall', v: data.lastRecall?.paths?.length ? `${data.lastRecall.paths.join(' · ')}（${data.lastRecall.tokens} ${t.tokens}）` : t.none },
      ]))
      recall.textContent = data.lastRecall?.text ? data.lastRecall.text : t.none
      recent.clear(t.empty)
      for (const doc of data.recent ?? []) {
        recent.addRow([doc.path, ctx.ui.pill(doc.status, doc.status === 'active' ? 'on' : 'off'), String(doc.chunks ?? ''), doc.updated || '—'])
      }
      cited.clear(t.empty)
      for (const item of data.topCited ?? []) {
        cited.addRow([item.path, String(item.count ?? '')])
      }
    }

    const refresh = async () => {
      try {
        render(await ctx.invoke('status'))
      } catch (error) {
        if (!ctx.signal.aborted) message.textContent = String(error?.message ?? error)
      }
    }

    let busy = false

    const run = async (reset) => {
      if (busy) return
      busy = true
      reindex.disabled = true
      rebuild.disabled = true
      message.textContent = t.working
      try {
        if (reset && !(await ctx.ui.confirm({ title: t.confirmReset, danger: true }))) {
          message.textContent = ''
          return
        }
        const result = await ctx.invoke('reindex', [{ reset }])
        message.textContent = result?.ok ? `${t.reindexed}：${t.scanSummary(result)}` : (result?.message || t.noIndex)
        await refresh()
        await ctx.refresh()
      } catch (error) {
        message.textContent = String(error?.message ?? error)
      } finally {
        busy = false
        reindex.disabled = false
        rebuild.disabled = false
      }
    }

    reindex.addEventListener('click', () => void run(false), { signal: ctx.signal })
    rebuild.addEventListener('click', () => void run(true), { signal: ctx.signal })

    await refresh()
    ctx.interval(() => {
      if (!busy) void refresh()
    }, 4000)
  },
}

/** 试检索面板。 */
const probePanel = {
  async mount(ctx) {
    const t = pick(ctx.language)
    const sheet = ctx.ui.sheet({ title: t.probeTitle })
    const bar = ctx.ui.rowbar()
    const input = ctx.ui.input({ placeholder: t.probePlaceholder, cls: 'mono' })
    input.style.flex = '1'
    const button = ctx.ui.button(t.search, { variant: 'primary', size: 'sm' })
    bar.append(input, button)
    const message = ctx.ui.msgline('')
    const table = ctx.ui.table({ head: [t.path, t.coverage, t.score, t.snippet], maxHeight: '360px' })
    sheet.body.append(bar, message, table.el)
    ctx.root.appendChild(sheet.el)

    const run = async () => {
      const query = input.value.trim()
      if (!query) {
        input.focus()
        return
      }
      button.disabled = true
      message.textContent = ''
      table.clear()
      try {
        const data = await ctx.invoke('search', [{ query }])
        if (data?.ok === false) {
          message.textContent = data.message || t.empty
          return
        }
        const hits = data?.hits ?? []
        if (!hits.length) {
          table.clear(t.empty)
          message.textContent = ''
          return
        }
        for (const hit of hits) {
          table.addRow([
            hit.path,
            hit.coverage == null ? '—' : `${Math.round(hit.coverage * 100)}%`,
            String(hit.score ?? ''),
            { text: hit.snippet ?? '', cls: 'txt' },
          ])
        }
      } catch (error) {
        message.textContent = String(error?.message ?? error)
      } finally {
        button.disabled = false
      }
    }

    button.addEventListener('click', () => void run(), { signal: ctx.signal })
    input.addEventListener('keydown', (event) => {
      if (event.key === 'Enter') void run()
    }, { signal: ctx.signal })
  },
}

export default { panels: { index: indexPanel, probe: probePanel } }
