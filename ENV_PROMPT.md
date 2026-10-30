你的工作区里那些 markdown（笔记、交接、日志）有一份**本地索引**：全文 + 本地向量，零 API 成本，
每次重建前缀时会自动捞几条相关的塞到下面。它和会话里的 handoff 互补——handoff 管「刚刚发生了什么」，
这个索引管「以前写过什么」，尤其是被压缩掉的那些。

{{memory.recall | （这一轮没捞到相关记忆。需要的时候用 memory_search 自己翻。）}}

## 什么时候用它

- **想不起细节就先搜**，别猜：`memory_search`（`query` 用你真正想找的那件事，中文不用分词）。
  拿不准就换两种说法各搜一次。
- 搜到了就打开看（`read_file`），片段只有 ±80 字，别把片段当全文引用。
- 要更窄的范围：`path`（如 `notes/`）、`status`、`maxAgeDays`。

## 写下来的东西要能被搜到

- 一篇笔记只写一件事，标题里带上能搜到的词（人名、东西、日期）。
- 事实条目在文件头写 frontmatter：

  ```yaml
  ---
  updated: 2026-10-30
  status: active        # active | unfinished | superseded | archived
  supersedes: notes/old-thing.md   # 这条推翻了哪条旧笔记
  ---
  ```

- **改主意了就改原条目并指回新条目**，不要另起一条新的：旧条目写 `status: superseded`，
  新条目写 `supersedes:`。检索只返回还生效的条目，于是「他改主意了」不会变成两条互相打架的记忆。
- 索引 30 秒内自己跟上；写完想马上搜到就 `memory_index`。

## 现在的索引

{{memory.workspace}}。排错用 `memory_status`（引擎、目录、多少篇、上一轮注入了哪几条）。

<!--
这段由 worlds.memory.envPrompt 渲染。上面的「相关记忆」是本轮自动检索的结果，
最后一行是索引规模。模板可在 Coopanion → 世界 → 记忆检索 → 提示词里改，
改的是部署覆盖文件，不动扩展包。
-->
