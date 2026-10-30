> 这份是「汐」在 2026-10-30 写的实现说明原文（工作区里的 `memory-retrieval-spec-2026-10-30.md`），
> 作为本项目的设计来源保留。第 4 节的验收点就是 `test/run.mjs` 在验的东西。
> 文中的「world」「handoff」「阿梦」都是当时的语境，代码对应关系见 README。

---
# 给 DSH 的实现说明：工作区自动检索（汐的记忆补丁）

写于 2026-10-30 15:3x，阿梦说可能让 DSH 来实现。以下是具体做法、接口、验收和参考资料。

---

## 1. 要解决的问题（只有三个）

1. **想不起来去翻**：现在的 recall 全靠我自己判断该 grep 什么关键词，判断错了就等于没有记忆。
2. **上下文一压缩就剩省略号**：handoff 只保最近一段，更早的细节丢失。
3. **流水账多、事实少**：同一件事改了主意就再堆一条，检索时新旧混在一起。

**不要**解决的：不要换 agent 运行时，不要接云端向量库，不要每轮调外部 LLM 做抽取（阿梦每天 token 预算 5 元）。

---

## 2. 总体设计

```
workspace/*.md ──(增量扫描, 按 mtime+hash)──> SQLite 索引
                                              ├─ docs      (路径/标题/正文/mtime/状态)
                                              ├─ docs_fts  (FTS5, trigram 分词, 中文友好)
                                              └─ (可选) vec (本地 embedding BLOB)
                                                        │
每轮开始 ──(当前话题/最近几条消息当 query)──> memory_search(top-k) ──> 「相关记忆」注入前缀
```

要点：
- **纯本地**，零 API 成本；索引文件放在 `<workspace>/.index/memory.db`，可随时删掉重建。
- **增量**：启动时全量扫一遍，之后每 30 秒或每次写文件后扫 mtime 变了的文件，重算 hash 才重建该文件的行。
- **不改**现有的 handoff / weight / fold 机制，两者互补：handoff 管「刚刚发生了什么」，索引管「以前写过什么」。

---

## 3. 具体实现

### 3.1 索引（Node + better-sqlite3）

```sql
CREATE TABLE docs (
  path TEXT PRIMARY KEY,
  title TEXT,
  body TEXT,
  mtime INTEGER,
  hash TEXT,
  status TEXT DEFAULT 'active'   -- active | superseded | archived
);
CREATE VIRTUAL TABLE docs_fts USING fts5(path UNINDEXED, title, body, tokenize='trigram');
```

- `tokenize='trigram'` 是 SQLite 3.34+ 自带，**中文按三字滑窗切**，不需要 jieba，`记忆模块` 这样两字词也能命中（trigram 对小于 3 字的 query 需要 `LIKE` 兜底，见下）。
- 分块：按标题/空行切成 300–800 字的 chunk，每个 chunk 一行（`path` + `chunk_no`），检索粒度更准。
- 中文 query 长度 < 3 时走 `body LIKE '%q%'`。

### 3.2 检索

```ts
memory_search(query: string, k = 5, opts?: {status?: 'active', maxAgeDays?: number})
```

1. FTS5 `MATCH` 取前 50 个 chunk；
2. （可选二期）向量召回前 50，和 FTS 结果用 RRF 融合：`score = Σ 1/(60+rank)`；
3. 重排：`score * (1 + 0.3*最近30天内被引用次数) * 时间衰减`；
4. 按 `path` 去重，每个文件最多 2 个 chunk；
5. 返回 `{path, title, snippet(±80字), score}`，总注入量硬上限 **2000 token**。

### 3.3 自动注入（关键）

在 world 每次 LLM 请求前（也就是现在放 handoff 的那个位置旁边）加一段：

```
## 相关记忆（自动检索，可能不全）
- [[notes/cet6-plan-2026-12-12.md]] 单词在「不背单词」上，每天 50 个…（2026-10-29）
- [[PARTNER.md]] 每天 token 上限 5 元…
```

query 的取法：最近 2 条人物消息 + 当前话题关键词；没有新消息时用最近写的 unfinished / 最近改动的文件名。**同一批记忆连续两轮不重复注入**（缓存上一轮注入的 path）。

### 3.4 事实条目（二期，但很值）

给笔记加 YAML 头：

```yaml
---
updated: 2026-10-30
status: active        # active | superseded
supersedes: notes/old-thing.md
---
```

检索只返回 `status: active`；被推翻的条目改 `status: superseded` 并指回新条目。这样「他改主意了」不会变成两条互相打架的记忆。

---

## 4. 分期与验收

**一期（估半天）**：FTS5 trigram 索引 + `memory_search` 工具 + 每轮自动注入 top-5 + 写文件后增量更新。
验收：问「我上次说的药水还剩几瓶」→ 注入里出现 `notes/pwa-run-state.md` 对应段落，且总注入 < 2000 token；`grep` 能找到的，`memory_search` 必须能找到。

**二期（估半天）**：frontmatter 过滤 + 时间衰减 + 引用计数 + 去重缓存。

**三期（可选）**：本地 embedding（`onnxruntime-node` + `bge-small-zh-v1.5` 或 `multilingual-e5-small`，约 100MB，CPU 够用），向量与 FTS 用 RRF 融合。**不接任何云端 API。**

失败兜底：索引损坏或没建好时，静默退回现有 `grep_files` 行为，不要报错打断对话。

---

## 5. 参考资料

点开看过的：
- Vuncloud《2026 最好的 AI Agent Memory 框架推荐（附 GitHub 排名）》
  https://vuncloud.com/zh/blog/articles/2026-08-07-best-ai-agent-memory-frameworks-ranking-github/2026-08-07-best-ai-agent-memory-frameworks-ranking-github.html
  —— 五个主流框架的对比矩阵、选型建议；提到 Mem0 的记忆抽取/去重、Zep 的时间一致性、Letta 的核心记忆自编辑 + 睡眠压缩。
- basic-memory（markdown 文件 + 本地 SQLite 知识图谱 + MCP）
  https://github.com/basicmachines-co/basic-memory
  —— 和本项目最接近的现成做法，可直接抄它的 markdown 解析和关系抽取思路。

没逐条点开（凭记忆，实现时自己核）：
- Mem0 https://github.com/mem0ai/mem0 （抽取/去重/更新一条龙，可本地化：SQLite/pgvector + 本地 embedding）
- Graphiti / Zep https://github.com/getzep/graphiti （时序知识图谱，「事实何时被推翻」，需 Neo4j/FalkorDB）
- Letta（前 MemGPT）https://github.com/letta-ai/letta （整个运行时，不适合本项目）
- Cognee https://github.com/topoteretes/cognee （文档→图，偏 RAG）
- LangMem https://github.com/langchain-ai/langmem （LangGraph 原生）
- SQLite FTS5 文档 https://sqlite.org/fts5.html （trigram tokenizer 在 3.34.0 起支持）

---

## 6. 一句话给阿梦

我不用 Mem0 那套，太重。给我做个「本地 FTS5 索引 + 每轮自动捞 5 条相关笔记塞进前缀」，再加上「事实条目带状态」就够了。改的是 world 的检索层，不动我这个人。
