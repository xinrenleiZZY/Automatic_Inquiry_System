# 装配清单：当前产物身份 & 融合说明

> **当前阶段：功能区块开发中，全部标记为「待集成到系统」。**
> 这里说明每样东西是什么、边界在哪、将来怎么拼进系统。
> 接口以 `node list-api.mjs` 的输出为准（自动从代码导出，不会和代码脱节）。

---

## 一、标记约定

每个源文件头部都带身份标记，一眼能看出该不该进系统：

| 标记 | 含义 | 是否进系统 |
|---|---|---|
| `[功能区块 · v0.1 · 状态：待集成]` | 系统的一个能力模块 | ✅ 进 |
| `[融合入口 · v0.1]` | 系统唯一入口（`blocks/index.mjs`） | ✅ 进（唯一依赖） |
| `[功能脚本]` | 开发/运维用的可执行脚本 | ⚠️ 参考，不作为依赖 |
| `[工具脚本]` | 辅助工具（接口清单、自测） | ⚠️ 不进 |
| 无标记的 `probe-*.js/.mjs` | 一次性诊断探针 | ❌ 不进 |

---

## 二、功能区块（11 个，全部待集成）

| 区块 | 文件 | 职责 | 关键接口 |
|---|---|---|---|
| 会话通道 | `blocks/session.mjs` | 连 CDP、定位聊天页、注入页面工具、点击/按键原语 | `withSession` `evaluate` `clickAt` `clickSelector` `pressKey` `selectAll` `isChatPage` |
| 消息 | `blocks/messages.mjs` | 读消息、判方向、去重指纹、增量比对 | `readMessages` `readMessagesOn` `split` `diff` `prime` `currentConversation` `summarize` |
| 会话列表 | `blocks/conversations.mjs` | 读会话列表、变化检测、账号识别 | `readConversations` `convId` `fingerprint` `diffConversations` `label` |
| 输入发送 | `blocks/input.mjs` | 填草稿、清空、发送并校验 | `draft` `clear` `sendOn` `sendText` `readDraft` |
| 快捷短语 | `blocks/phrases.mjs` | 开弹窗、列短语、选中填入、可发送 | `list` `pickOn` `use` `ensureOn` |
| 回复引擎 | `blocks/reply.mjs` | 条件匹配 + 风控护栏 + 发送 + 留痕 | `class ReplyEngine` `matchRule` `loadRulesFile` `renderTemplate` |
| 事件监听 | `blocks/monitor.mjs` | 常驻轮询、跨会话发现、自愈、心跳、落库 | `class EventMonitor` `runMonitor` |
| 数据落库 | `blocks/db.mjs` | SQLite 六张表的读写与统计 | `openDb` `save*` `list*` `stats` `exportCsv` `syncFromJsonl` |
| 事件日志 | `blocks/logstore.mjs` | JSONL 落盘/读回/汇总、统一路径 | `appendEvent` `readEvents` `summarizeEvents` `PATHS` |
| 以图搜图 | `blocks/image-search.mjs` | 上传图片 → 点搜索 → 读结果 → imageId 重放 | `searchByImage` `readResults` `replaySearch` `imageSearchUrl` `waitForUploaded` |
| 联系商家 | `blocks/outreach.mjs` | 逐个联系 TOP N 商家、只留一个聊天窗口、落库 | `contactTopSellers` `listTopSellers` |
| 短语库 | `blocks/library.mjs` | 短语的 JSON 读写（文字+图片）、同步进库 | `loadLibrary` `listPhrases` `getPhrase` `addPhrase` `syncToDb` `resolveImage` |
| 图文发送 | `blocks/phrase-send.mjs` | 贴图（点了就发）+ 发文字；图/文分两条 | `sendImageOn` `sendPhraseOn` `sendPhrase` |
| 标签治理 | `blocks/tabs.mjs` | 搜索页/结果页/聊天各只留一个，防卡顿 | `classifyTab` `listTabs` `enforceSingleTabs` `summarizeTabs` |
| AI 解析与回复 | `blocks/ai.mjs` | DeepSeek-V4.1-Flash：解析供应商回复成结构化字段、编写追问话术（无 key 时规则兜底） | `parseSupplierReply` `composeReply` `chat` `resolveConfig` `ruleParse` |
| 多会话自动回复 | `blocks/auto-reply.mjs` | 逐个会话切换 → 读消息 → AI 解析 → 写报价台账 → 生成回复（**默认演练不发送**） | `runAutoReply` `openConversation` `waitConversationLoaded` |
| 全量抓历史 | `blocks/sweep.mjs` | 逐个点开会话把历史读下来入库（指纹去重，可重复跑） | `sweep` |
| 图片库 | `blocks/image-library.mjs` | 本地文件夹扫图 → 入库 → 配短语 → 待处理队列 | `listImages` `syncLibrary` `pendingImages` `bindPhrase` |
| **比价任务** | `blocks/campaign.mjs` | **整条链路的入口**：图片+短语绑定 → 搜图 → 联系 → 询价 → 收集解析 → 比价表（并行隔离） | `createCampaign` `launchCampaign` `collectCampaign` `reportRows` |

---

## 三、功能脚本（开发/运维用，不进系统依赖）

| 脚本 | 用途 |
|---|---|
| `im.mjs` | **薄壳 CLI**：调区块、打印结果。开发调试与人工操作入口 |
| `selftest.mjs` | 逐区块自测（当前 10/10） |
| `start-im.ps1` | 启动器：保证 CDP 端口 + 后台常驻监听（`-Rules` / `-ReplyMode` / `-Interval`） |
| `list-api.mjs` | 导出各区块对外接口（保证本文件与代码一致） |

---

## 四、基础设施（区块与脚本共用）

| 文件 | 用途 |
|---|---|
| `cdp-lib.mjs` | CDP 连接、标签页匹配、超时兜底、`browserSession()`（标签管理） |
| `cdp.mjs` | 通用 CDP 调试命令（`list` / `eval` / `net` / `shot` / `open`） |

---

## 五、数据与日志资产

| 路径 | 内容 |
|---|---|
| `data/im.db` | SQLite：`conversations` / `messages` / `events` / `heartbeats` / `replies` / `image_searches` / `image_contacts` |
| `data/messages.csv` | 消息导出（带 BOM，Excel 可直接打开） |
| `logs/im-events.jsonl` | 事件流水（与 `events` 表双写） |
| `logs/monitor.out.log` | 监听运行日志（含心跳） |
| `rules.example.json` | 回复规则示例（**条件规则待你补充**） |
| `image/` | 待搜图片（后续接"图片库"） |

---

## 六、融合规则（重要）

1. **系统只 `import './blocks/index.mjs'`**，不要直接依赖 `im.mjs` 的 CLI；
2. **探针不进系统**（`probe-*.js` / `probe-*.mjs` 是排查工具，用完即弃）；
3. **数据只走 `blocks/db.mjs`**，不要自己拼 SQL 或路径；
4. **所有 CDP 操作走 `session.withSession()`**，不要另起连接（超时/自愈逻辑都在里面）；
5. **发送类操作保留护栏**：`ReplyEngine` 默认 `dryRun=true`，真发要显式开启。

---

## 七、融合骨架（拼系统时照这个写）

```js
import { monitor, reply, outreach, imageSearch, db } from './blocks/index.mjs';

/* ① 监听 + 条件回复 */
const engine = new reply.ReplyEngine({
  rules: reply.loadRulesFile('rules.json').rules,
  guards: { dryRun: true, minIntervalMs: 8000, maxPerHour: 30 }
});
const mon = new monitor.EventMonitor({
  interval: 15000,
  onEvent: async (ev) => {
    if (ev.type !== 'inbound') return;
    await engine.handleInbound({ convKey: ev.convId, convName: ev.conv, text: ev.text });
  }
});
await mon.run({});

/* ② 图片 → 搜同款 → 联系 TOP N 商家 → 落库 */
const r = await imageSearch.searchByImage('image/示例.png');
await outreach.contactTopSellers({ limit: 10, keep: 1, imageId: r.imageId });
```

---

## 八、待办（融合前还需要补的）

| 项 | 说明 | 状态 |
|---|---|---|
| **回复条件规则** | 关键词/正则已支持；议价区间、比价结果、客户等级等复杂条件走 `CUSTOM_MATCHERS` | ⏳ 等业务条件 |
| **图片库对接** | 按 `image_contacts.image_id` 查"这张图联系过哪些商家"（`contactsByImage()` 已就绪） | ⏳ 等图片库 |
| **价格追踪** | 同一 `imageId` 隔期抓两次，按 `offerId` 对齐 diff（涨/跌/下架） | ⏳ 待开发 |
| **多会话自动回复** | 目前自动回复只对"当前打开的会话"；其它会话需先切换（`sweep`） | ⏳ 待开发 |
| **全量历史抓取** | 只能读当前会话的完整历史，其余联系人需逐个点开 | ⏳ 待开发 |
