# cortico-world-memory（记忆检索）

给 [Coopanion](https://github.com/Pal-AI-Lab/Coopanion) / Cortico 加一层**工作区记忆检索**：
把工作区里的 markdown 建成本地索引，**每次重建 system 前缀时自动捞几条相关笔记塞进去**，
再给模型一个 `memory_search` 按需翻旧账。纯本地、零 API 成本、索引删了自动重建。

它解决三件具体的事：

| 问题 | 这里怎么解 |
|---|---|
| 想不起来去翻：全靠自己猜关键词 grep，猜错就等于没记忆 | 每轮自动检索（不靠模型想起来）+ `memory_search` 兜底 |
| 上下文一压缩就剩省略号：handoff 只保最近一段 | 索引管「以前写过什么」，交接之后照样能捞回来 |
| 流水账多、事实少：改主意就再堆一条，检索时新旧打架 | frontmatter `status` + `supersedes`，被推翻的条目自动失效 |

不换 agent 运行时、不接云端向量库、不在每轮调外部模型做抽取。

## 装

```powershell
node tools\install.mjs                 # 建链接 + 在部署配置里启用
# 重启 Coopanion
```

`install.mjs` 做两件事：在 `<Coopanion>\data\extensions\node_modules\` 下建一个指向本仓库的
junction，并把 `worlds.memory.*` 写进 `<Coopanion>\data\home\companion\config.json`。
装到别处用 `--coopanion "<目录>"`，要索引别的目录用 `--workspace "<目录>"`。

装好后：Coopanion → 世界 → **记忆检索**，两个面板：

- **索引状态**：引擎（SQLite FTS5 / grep 兜底）、向量层、索引目录、多少篇/多少段、上次扫描、
  上一轮注入了哪几条、最近改过的笔记、最近常被引用的笔记；
- **试检索**：输入一句话直接看会拿到哪几段（排「为什么它想不起来」用）。

停用：`node tools\install.mjs --disable`。

## 它在前缀里长什么样

World 的环境段（`## memory`）里会多出这么一段：

```
## 相关记忆（自动检索，可能不全）
- [[notes/pwa-run-state.md]] …这局的药水只有敏捷药水，血 47/80，钱 0…（2026-10-30）
- [[PARTNER.md]] 每天 token 上限 5 元…（2026-10-20）
```

- 条数 `worlds.memory.topK`（默认 5），**总注入硬上限 2000 token**；
- **同一批记忆连续两轮不重复注入**，换话题才重置；
- 检索超时就不注，后台跑完下一条前缀生效——不阻塞前缀构建。

> 注入点是 **system 前缀**：Coopanion 在会话开始、上下文交接、前缀重载时重建它
> （也就是 handoff 落地的那个位置），所以不是每条消息都重搜。会话中间要立刻翻东西，
> 用 `memory_search`——环境提示词里已经写了「想不起细节就先搜，别猜」。

## 索引

```
workspace/*.md ──(mtime+size 变 → 重读 → sha1 变才重切)──> <workspace>/.index/memory.db
                                                          ├─ docs     一篇一行（标题/状态/关系）
                                                          ├─ chunks   300–800 字段，带上下文小标题
                                                          ├─ docs_fts FTS5 trigram（rowid = chunk id）
                                                          └─ refs     引用流水（算 30 天内引用数）
```

- 引擎是 Node 24 自带的 `node:sqlite`（SQLite 3.53，FTS5 带 trigram），**零 npm 依赖、零编译**；
- 首扫全量，之后 `fs.watch`（写文件 800ms 内）+ 每 30 秒定时 + 每次检索前按需补扫；
- 跳过 `.git`、`node_modules`、`blobs`、`log`、`data`、`archive`、`tmp` 与点开头目录；
- 按标题/空行切成 300–800 字的段，代码块不切，每段带上文档标题与小节名；
- 索引是纯派生物：**删了自动重建**，工作区里一个文件都不动（面板「存储」也能一键清）。

## 检索怎么算分

```
FTS5(trigram)  ┐
LIKE 兜底       ├─ RRF 融合 Σ1/(60+rank) ─ ×(0.55+0.95×覆盖率) ─ ×(1+0.3×30天引用数) ─ ×时间衰减
本地向量        ┘
```

三路各自解决一个问题：

1. **trigram 只认逐字出现**。一句自然问句（`我上次说的药水还剩几瓶`）在原文里几乎不可能整段出现，
   所以查询本身也要拆成三字滑窗再 OR——不然什么都搜不到。
2. **两字词索引不到**（trigram 的硬限制）。`药水` 这种中文两字词的召回只能靠 LIKE 兜底扫原文。
3. **字面不重合但语义近**的靠本地向量补。默认是内置的哈希 n-gram 向量（零依赖、CPU 毫秒级）；
   把 `worlds.memory.embedModel` 指到放了 `model.onnx` + `vocab.txt` 的目录、并装了
   `onnxruntime-node`，就换成真 embedding（bge-small-zh / multilingual-e5 都行）。**不联网。**

最后的**覆盖率**用候选池里的 IDF 加权：`怎么`、`什么` 这种到处都是的二元组几乎没有区分度，
`六级`、`药水` 这种只在两三段里出现的才说了算。这一层是把「召回一堆有点像的」收成
「按相关度排好的几条」的关键。

## 事实条目：别让记忆打架

笔记开头写 YAML 头即可：

```yaml
---
updated: 2026-10-30
status: active          # active | unfinished | superseded | archived
supersedes: notes/old-potion-rule.md
tags: [sts2, potion]
---
```

- 检索默认只回 `active` 与 `unfinished`；`archived` 永不返回；`superseded` 要用
  `memory_search(status: "superseded")` 才翻得出来。
- 新条目写 `supersedes`，旧条目**自动**变 `superseded` 并记下 `supersededBy`，
  不用手改两份。这样「他改主意了」不会变成两条互相打架的记忆。
- 还认 `title`（显示标题）、`date` / `last_updated`（都算 updated）。

## 工具

| 工具 | 参数 | 干什么 |
|---|---|---|
| `memory_search` | `query`（必填）、`k`、`status`、`maxAgeDays`、`path` | 检索，回 `{path,title,snippet,score,status,updated,cited}` |
| `memory_index` | `reset` | 增量重建；`reset:true` 从头建 |
| `memory_status` | — | 引擎、目录、规模、上一轮注入、上次扫描 |

## 配置（`worlds.memory.*`）

面板上都能改；`workspace` / `embedModel` 改了要重启。

| 键 | 默认 | 说明 |
|---|---|---|
| `workspace` | `<部署>/workspace` | 索引哪个目录 |
| `indexPath` | `<workspace>/.index/memory.db` | 索引文件 |
| `inject` | true | 关掉后只能手动搜 |
| `topK` | 5 | 每轮注入几条 |
| `budgetTokens` | 2000 | 注入 token 硬上限 |
| `minCoverage` | 0.12 | 低于它的候选不进前缀 |
| `halfLifeDays` | 90 | 时间衰减半衰期；0 = 不衰减 |
| `refBoost` | 0.3 | 30 天内每次引用的加成 |
| `maxAgeDays` | 0 | 只搜这么多天内改过的 |
| `vector` | auto | `off` = 只用全文 |
| `embedModel` | 空 | ONNX 模型目录（可选） |
| `scanSeconds` | 30 | 后台扫描间隔 |
| `skipDirs` | 见上 | 逗号分隔 |
| `queryHint` | 空 | 钉一个当前话题词，拼进自动检索的 query |
| `humanSources` | 空 | 只把这些来源当「人说的话」 |
| `maxChars` | 4000 | 工具回执上限 |
| `chunkMin` / `chunkMax` | 300 / 800 | 分块长度 |
| `maxFileKb` | 2048 | 单篇最大读取量 |

## 兜底

- 没有 `node:sqlite`、索引打不开、目录写不了 → **不报错**，检索退回直接扫文件的 grep
  （面板显示 `grep 兜底`），对话照常；
- 检索超时 → 这一轮不注入；
- 任何异常都只记 warn，绝不从 `envPromptVars()` 里抛——抛了 Core 会把整个 World 卸掉。

## 实测（99 篇 / 6537 段的工作区）

| 项 | 数 |
|---|---|
| 首扫（含向量） | ~1.7 s |
| 单次检索 | 40–90 ms |
| 索引大小 | ~43 MB |
| 一轮注入 | 4–5 条 ≈ 280–530 token（上限 2000） |

## 测试

```powershell
node test\run.mjs          # 97 项：纯函数 + 索引/检索/注入/去重/面板 + 真实工作区
node test\run.mjs --real   # 真实工作区必须存在且通过，否则失败
```

验收点（对应 [SPEC.md](SPEC.md) 第 4 节）：问「我上次说的药水还剩几瓶」→ 注入/检索里出现讲这一局
的那几篇（`notes/pwa-run-state.md`、`notes/sts2/pwa-battle-log-*.md` 之类），片段里带「药水」，
总量 < 2000 token；`grep` 能找到的，`memory_search` 必须能找到。

## 排错

| 现象 | 看哪里 |
|---|---|
| 面板显示「grep 兜底」 | 这个运行时的 `node:sqlite` 打不开，看面板上的 error |
| 注入一直是空的 | `memory_status` 的 `lastQuery` 是否为空；`docs` 是否为 0；`minCoverage` 是不是卡太高 |
| 改了笔记搜不到 | 等 `scanSeconds`（30 秒）或直接 `memory_index`；也确认没落在 `skipDirs` 里 |
| 索引太大 | 面板「存储」一键清，或调小 `chunkMax` / 加 `skipDirs` |

## 发布

```powershell
node tools\pack.mjs        # release\cortico-world-memory-<version>.zip
node tools\publish.mjs     # 建/更新仓库、提交、release 与资产
```

token 读 `GITHUB_TOKEN`，或 `%USERPROFILE%\.pwa\github-token.txt`。

## 许可

MIT。不包含任何第三方二进制；ONNX 是**可选**依赖，装不装都能跑。
设计来源见 [SPEC.md](SPEC.md)（汐写的实现说明）。
