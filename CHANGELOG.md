# Changelog

## 1.0.0 - 2026-10-30

首个版本。把工作区的 markdown 建成本地索引，每轮重建 system 前缀时自动注入相关笔记。

**索引**

- `node:sqlite` + FTS5 `trigram`（中文免分词，零 npm 依赖）；索引在 `<workspace>/.index/memory.db`，可随时删了重建
- 增量：`mtime`/`size` 变了才重读，`sha1` 也变了才重切；`fs.watch` + 30 秒定时 + 检索前补扫
- 分块：按标题/空行切 300–800 字，代码块不切，每段带文档标题与小节名
- 跳过 `.git` / `node_modules` / `blobs` / `log` / `data` / `archive` / `tmp` 与点开头目录
- 向量以 Float32 BLOB 存在 `chunks.vec`，换向量层时整体重建

**检索**

- FTS5(trigram) + LIKE 兜底 + 本地向量三路召回，RRF（`Σ1/(60+rank)`）融合
- 中文查询拆三字滑窗再 OR——trigram 只认逐字出现，整句匹配几乎不可能
- 两字词与 <3 字词走 LIKE 扫原文（trigram 索引不到）
- 覆盖率用候选池内 IDF 加权，压掉 `怎么`/`什么` 这类到处都是的二元组
- 引用计数（30 天窗口 ×`refBoost`）+ 时间衰减（半衰期 90 天，最低 0.15）
- 按 `path` 去重，一个文件最多 2 段；总 token 硬上限
- 内置哈希 n-gram 向量（零依赖）；`embedModel` + `onnxruntime-node` 可换真 embedding，**不联网**

**注入**

- `envPromptVars()` 返回 `memory.recall`，模板里就是「相关记忆」那一段
- 每轮 top-5、硬上限 2000 token；**连续两轮不重复注入**，换话题才重置
- query 取最近 2 条人话（`ok`/`嗯` 这类纯应答不算），没有新消息时退到最近改动的文件名
- 超预算就先不注，后台跑完下一条前缀生效；任何异常都不从 `envPromptVars()` 抛

**事实条目**

- frontmatter `status`（active / unfinished / superseded / archived）、`updated`、`supersedes`、`tags`、`title`
- 新条目写 `supersedes`，旧条目自动变 `superseded` 并记 `supersededBy`

**工具与面板**

- `memory_search` / `memory_index` / `memory_status`
- 面板「索引状态」（引擎、目录、规模、上次扫描、上一轮注入、最近改动、常被引用）与「试检索」
- 可清除的索引存储项；`worlds.memory.*` 一组配置

**兜底**

- 索引不可用时不报错，检索退回直接扫文件的 grep

**验证**

- 95 项端到端测试（含真实工作区 99 篇 / 6537 段）全过
- Coopanion `dryMountWorld` + `parseExtensionManifest`：0 failure / 0 warning
