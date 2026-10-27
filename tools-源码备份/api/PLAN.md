# 方案 v2 · 零改源码 · CDP + Python 接口层

> 状态：**待审核**（本文档只做设计，未写任何实现代码）
> 用途：把已完成的 Node 功能区块暴露成 HTTP API，供 Automatic_Inquiry_System（Docker + 业务前端）调用
>
> v2 相对 v1 的三处硬变更：
> 1. **硬约束：现有源码一行不改** —— tools/qianniu/** 全部冻结
> 2. 发送模式：**生产直接真实发送**；draft 只在测试阶段使用
> 3. 前端页面清单已确定（8 个页面）→ 见 §7

---

## 一、硬约束（红线）

| 项 | 内容 |
|---|---|
| **冻结** | tools/qianniu/** 下所有 .mjs / .js / .ps1 / .json：不改、不重构、不搬运、不美化 |
| **冻结** | 数据库 data/im.db 的**表结构**（Node 侧已建 15 张表）：Python 不建表、不加列、不改类型 |
| **允许新增** | 新目录 tools/api/**：Python 代码、桥接脚本、Python 自己的配置文件 |
| **允许新增** | Python 自己的库 tools/api/data/api.db（参数设置 / 黑白名单 / 审计），**与 im.db 物理隔离** |
| **依赖方式** | Python 只调用**已存在的公开面**：CLI（im.mjs 38 个命令）、冻结入口（blocks/index.mjs 约 120 个导出函数）、只读 SQLite |

**唯一需要你点头的一点**：桥接脚本 tools/api/bridge.mjs 是**新增文件**（放在 tools/api/ 下，**不落进** tools/qianniu/）。它只做一件事：

```js
import * as blocks from '../qianniu/blocks/index.mjs';   // 冻结入口，只读引用
```

把区块函数翻译成 JSON 命令。**它不修改任何既有文件**。若你要求"连一个新增 JS 都不许"，退回 §2.2 的纯 CLI 方案（可行，但代价明确）。

---

## 二、为什么需要一个桥接脚本

### 2.1 三条通道对比

| 通道 | 做法 | 输出 | 延迟 | 改源码 | 定位 |
|---|---|---|---|---|---|
| **A. CLI 子进程** | Python subprocess 调 node im.mjs | ❌ 中文排版文本，需正则解析 | 每次 1~2s 进程启动 | 零 | **兜底** |
| **B. 桥接常驻**（推荐） | 常驻 bridge.mjs → import blocks/index.mjs | ✅ 原生结构化对象 | 毫秒级 | 零（**仅新增文件**） | **主方案** |
| **C. 直读 SQLite** | Python sqlite3 只读查询 | ✅ | 毫秒级 | 零 | **报表/查询专用** |

**结论：B 做「操作」，C 做「查询」，A 做「兜底/应急」。**

### 2.2 若不允许新增 JS（纯 CLI 方案）的真实代价

1. 38 个命令里只有 dashboard / stats 返回 JSON，其余全是给人看的排版文本 → Python 必须写正则解析，**Node 侧改一句文案就崩**。
2. 每条命令一次进程启动（1~2s），15 秒轮询会持续吃 CPU。
3. 拿不到中间结构（例如"搜图返回的 60 张卡片"），只能拿"已经落库的那部分"，接口能力被砍掉约三成。

---

## 三、现状核实（均为实测，非推测）

| 项 | 实测结果 |
|---|---|
| 源码规模 | 21 个功能区块 + 2 个基础设施（cdp-lib.mjs / cdp.mjs），冻结入口 blocks/index.mjs 已导出全部 21 个区块 |
| 公开面 | 21 个区块共 **约 120 个导出函数**；CLI **38 个命令** |
| 数据库 | 15 张表；当前：会话 38 / 消息 276 / 页面价 180 / 报价台账 14 / 任务 2 / 已联系商家 79 / 短语发送 42 / 自动回复 15 / 图片库 5 / 短语库 2 |
| 运行态 | 常驻监听**存活中**：PID 43616，已运行 115 分钟、461 次轮询、0 次重连（日志 logs/monitor.out.log）；CDP 127.0.0.1:9222 可达 |
| 注意 | 3 个 9/22 的 node 进程（PID 16648 / 37880 / 44728）疑似历史探针残留，**未动**，上生产前需确认清理 |

---

## 四、架构

```
┌────────────────────────────────────────────────────────────┐
│  Automatic_Inquiry_System（Docker + 业务前端，8 个页面）      │
└───────────────────────┬────────────────────────────────────┘
                        │ HTTP/JSON（自带 OpenAPI 文档）
┌───────────────────────▼────────────────────────────────────┐
│  Python API 层（FastAPI）                                   │
│   ├─ REST 接口（读写）                                       │
│   ├─ 单 worker 串行队列  ← 唯一仲裁者，浏览器操作永不同时    │
│   ├─ 只读 SQLite 查询（报表，不进队列）                       │
│   └─ 流程启停（监控进程 + 队列自身）                          │
└───┬──────────────────────┬───────────────────┬─────────────┘
    │ ① JSON-line stdio    │ ② sqlite3 只读    │ ③ 子进程启停
┌───▼──────────────┐  ┌────▼─────────────┐  ┌─▼──────────────┐
│ Node Bridge 常驻  │  │ data/im.db       │  │ 常驻监听 monitor│
│ tools/api/        │  │ （Node 侧写入）   │  │ start-im.ps1    │
│   bridge.mjs      │  │ Python 只读      │  │ 15s 轮询→入库   │
└───┬──────────────┘  └──────────────────┘  └─┬──────────────┘
    │ import（只读）                            │
┌───▼───────────────────────────────────────────▼────────────┐
│  tools/qianniu/**  ← 冻结，一行不改                          │
│  blocks/index.mjs（冻结入口，21 个区块）                      │
└───┬────────────────────────────────────────────────────────┘
    │ CDP(WebSocket)                      │ SQLite(WAL)
┌───▼──────────────────┐         ┌────────▼───────────┐
│ Chrome 152 调试实例   │         │ data/im.db         │
│ --remote-debugging-port=9222（已登录 1688）              │
└──────────────────────┘         └────────────────────┘
```

### 4.1 为什么必须"单 worker 串行"

这不是设计洁癖，是源码里已经写明的实测结论：

1. 聊天窗口是**独占资源**：发送/读消息都要求"当前打开的就是那个会话"。
2. blocks/lock.mjs 已给「搜图 / 联系商家 / 自动回复 / 采集 / 清扫」加了进程锁，但 **监听进程没加锁**，而且它每 30 分钟会 reload 页面。
3. 两个流程同时动页面 = A 正发消息时，B 的"开一个关一个"逻辑会把 A 的窗口关掉。

所以 **Python 层做唯一仲裁者**：所有"会动浏览器"的动作排一条队，任何时刻只有一个在跑。查询类（只读 SQLite）**不进队列**，前端怎么点都不会阻塞。这也正好对应你要的"一个终端同时推进多个不同任务"——多任务靠队列轮转，而不是多进程抢窗口。

---

## 五、两个 Node 运行实体的分工（关键设计）

| 实体 | 谁拉起 | 职责 | 为什么必须这样 |
|---|---|---|---|
| **常驻监听 monitor** | start-im.ps1（现有脚本，不动） | 15s 轮询 → 消息/会话落库 → 心跳 | 它的"已读基线"（msgSeen / convSeen）存在**内存**里，一次性巡检每次都会重建基线，**永远检测不到新消息**（已核实源码）。所以它必须常驻 |
| **常驻桥接 bridge** | Python 拉起 | 所有操作类调用（搜图/联系/发送/采集/解析） | 复用 CDP 连接、返回结构化对象、避免每次起进程 |

### 两条硬规则（保证二者不打架）

**规则 1：监听进程必须关掉自带刷新**
启动时用 monitor --refresh 0。30 分钟刷新改由 **Python 队列在空闲点执行**：
attach(page) → session.send('Page.reload') → ensureHelpers(session) → 页面内 __QN.ensureAllTab()
（全部是已导出的能力，零改源码）。这样刷新**不可能**再打断正在跑的搜图/联系/发送。

**规则 2：监听进程不启用自动回复**
不加 --rules。自动回复统一由 Python 队列用 runAutoReply({ mode, onlyConvKeys }) 驱动。
**这是"黑名单 / 白名单 / 终止追踪"能真正生效的前提**（见 §8），否则监听进程会绕过你的名单自己发消息。

### 备选形态（可选，P3）

若你希望"只有一个终端里只有一个 Node 进程"：可用 bridge.mjs --with-monitor，让 bridge 在自身进程内跑 monitor（monitor.runMonitor 已导出）。代价是耦合度升高、bridge 崩了监听一起停。**默认不开**，保持现有已验证的运维方式。

---

## 六、接口清单（全部映射到真实函数，无凭空造）

统一前缀 /api/v1，统一响应 { ok, data, error, elapsed_ms }。

### 1. 系统
| 方法 | 路径 | 落到哪里 |
|---|---|---|
| GET | /system/health | CDP /json/version + im.db 可读 + monitor PID 存活 + bridge 存活 |
| GET | /system/status | db.stats() + 心跳表最新一条 + 任务/客户/消息计数 |
| GET | /system/commands | 静态清单（38 个 CLI 命令 + 120 个区块函数，供前端做菜单） |
| GET | /system/config | 轮询间隔、发送模式、队列长度、护栏参数 |

### 2. 比价任务（核心业务对象）
| 方法 | 路径 | 落到哪里 |
|---|---|---|
| POST | /campaigns | campaign.createCampaign(db, {image, phraseId, name, note}) |
| GET | /campaigns | db.listCampaigns(db, limit) |
| GET | /campaigns/{id} | db.getCampaign + db.campaignContacts + db.quotesFor 计数 |
| POST | /campaigns/{id}/launch | campaign.launchCampaign(db, c, {limit, yes:true}) 搜图→联系→发询价 |
| POST | /campaigns/{id}/collect | campaign.collectCampaign(db, c, {mode, slice}) 收回复→AI解析→追问 |
| POST | /campaigns/{id}/advance | scheduler.advanceCampaign(db, c, {slice, perTask, mode}) **单步推进**（队列用） |
| GET | /campaigns/{id}/report | campaign.reportRows(db, id, {from, to}) 比价表 |
| POST | /campaigns/{id}/pause /resume | db.updateCampaign(db, id, {status:'paused'|'running'}) |
| GET | /campaigns/{id}/contacts | db.campaignContacts(db, id) |

### 3. 流程启停
| 方法 | 路径 | 说明 |
|---|---|---|
| POST | /flows/monitor/start /stop | 拉起 / 停止 node im.mjs monitor --refresh 0（或 start-im.ps1） |
| GET | /flows/monitor/status | PID + 心跳表 + 日志尾部 |
| POST | /flows/queue/start /stop | Python 串行队列自身的开关 |
| POST | /flows/queue/tick | 手动踢一次（前端"立即推进一轮"按钮） |
| GET | /flows | 队列 + monitor + bridge 一览，含崩溃识别与退出码 |

### 4. 发送（生产即真实发送）
| 方法 | 路径 | 落到哪里 |
|---|---|---|
| POST | /send/text | input.sendText(text) |
| POST | /send/phrase | phraseSend.sendPhrase(phrase, {order, send:true, ...}) 图文短语=两条消息 |
| POST | /send/image | phraseSend.sendImageOn(session, file)（贴图即发，无预览） |
| POST | /send/reply | autoReply.runAutoReply({mode:'send', onlyConvKeys}) |

### 5. 搜图与联系
| 方法 | 路径 | 落到哪里 |
|---|---|---|
| POST | /search/image | imageSearch.searchByImage(file, opts) → 返回 imageId + 卡片 |
| GET | /outreach/sellers | outreach.listTopSellers(limit) 纯读结果页商家 |
| POST | /outreach/contact | outreach.contactTopSellers({limit, skipSent, campaignId, ...}) |

### 6. 数据查询（Python 直读 SQLite，不走 Node）
| 方法 | 路径 | 说明 |
|---|---|---|
| GET | /data/compare | **全局比价表** ?campaign_id=&product=&from=&to=&only_priced= |
| GET | /data/quotes | supplier_quotes 台账（14 列 + 页面价/口径/可比单价） |
| GET | /data/customers | 客户台账：会话 ↔ 图片 ↔ 短语 ↔ 报价 联查 |
| GET | /data/chat/{conv_key} | 单个客户完整往来（messages 按会话） |
| GET | /data/messages | 消息分页查询 |
| GET | /data/stats | 统计总览（按天/任务） |
| GET | /data/export/*.csv | 导出（比价表/报价台账/客户） |

### 7. 库与 AI
| 方法 | 路径 | 落到哪里 |
|---|---|---|
| GET/POST/PUT/DELETE | /phrases[/{id}] | library.loadLibrary / saveLibrary / addPhrase + db.syncToDb |
| GET/POST/DELETE | /library/images[/...] | imageLibrary.listImages({dir}) / syncLibrary + db.upsertLibraryImage / markLibraryImage |
| POST | /library/bind | imageLibrary.bindPhrase(db, imagePath, phraseId) |
| POST | /ai/parse | ai.parseSupplierReply({inquiry, replyText, product, context, known, opts}) |
| POST | /ai/compose | ai.composeReply({known, missing, product, order_moq}) |
| GET | /ai/config | ai.resolveConfig / ai.hasApiKey |

### 8. 业务参数（Python 自己的库 tools/api/data/api.db，不碰 im.db）
| 方法 | 路径 | 说明 |
|---|---|---|
| GET/PUT | /settings | 询价数量、最多询价数、预期价格、slice、发送间隔/上限/免打扰 |
| GET/PUT | /settings/whitelist /settings/blacklist | 客户名单 |
| POST | /customers/{conv_key}/drop /restore | 终止追踪（直接放弃）／恢复 |

---

## 七、前端 8 个页面 → 接口映射（按你给的清单）

| # | 页面 | 页面内容 | 主要接口 |
|---|---|---|---|
| 1 | **首页仪表盘** | 系统健康、监听/队列状态、任务数、客户数、消息数、今日发送数、最近事件流 | /system/health /system/status /flows /data/stats |
| 2 | **任务列表** | 任务 CRUD、阶段进度（搜图→联系→采集）、启停、单步推进 | /campaigns 系列 |
| 3 | **比价表** | 按时间区间+商品出表、页面价 vs 回复价、报价口径、达标判定、导出 CSV | /data/compare /campaigns/{id}/report /data/export |
| 4 | **客户中心** | 客户台账 + 单个客户完整往来（可单独调出） | /data/customers /data/chat/{conv_key} |
| 5 | **客户管理** | 白名单/黑名单、**终止追踪（放弃）**、恢复追踪 | /settings/whitelist /settings/blacklist /customers/{key}/drop |
| 6 | **参数设置** | 询价客户数量、最多询价客户数量、预期价格要求、每轮处理数、发送间隔/每小时上限/免打扰、图片库根目录 | /settings |
| 7 | **图片库** | 图片增删改查、文件夹同步、与快捷短语绑定 | /library/images 系列 |
| 8 | **快捷短语** | 短语增删改查（文字+图）、与图片绑定、启停用 | /phrases 系列 |

---

## 八、业务参数如何真正生效（零改源码的落点）

| 参数 | 存在哪 | 怎么生效（不动源码） |
|---|---|---|
| 询价客户数量（每任务联系几家） | Python 配置 | 传给 contactTopSellers({limit}) / advanceCampaign({perTask}) |
| 最多询价客户数量（全局上限） | Python 配置 | 入队前查 image_contacts 当前总数，超限则不再入队新任务 |
| 每轮处理会话数 slice | Python 配置 | collectCampaign({slice}) |
| 预期价格要求 | Python 配置 | **在报表层判定"达标/超标"**，不打断采集（采集全量，判定在展示层） |
| 发送间隔 / 每小时上限 / 免打扰 | Python 配置 | runAutoReply({maxPerHour, minIntervalMs, quietHours}) —— 这三个键 guardCheck 已原生支持 |
| 客户白名单 | Python 配置 | runAutoReply({onlyConvKeys: 白名单}) —— 只处理名单内会话 |
| 客户黑名单 | Python 配置 | ① 回复层 onlyConvKeys 排除（**100% 生效**）② 触达层 DOM 预过滤（见 8.2） |
| 终止追踪 / 放弃某客户 | Python 配置 | 写入"放弃名单" → onlyConvKeys 排除 + 报表标记 + 不再追问 |
| 图片库根目录 | Python 配置 | listImages({dir}) |

### 8.1 为什么这些参数不需要改源码

runAutoReply 已经原生支持 onlyConvKeys（源码注释写明就是给"比价任务做隔离"用的），guardCheck 已支持 maxPerHour / minIntervalMs / quietHours。这两个口子足够承载全部名单与频率类参数。

### 8.2 黑名单在"触达层"为什么只能算"尽量"

contactTopSellers **只接受 limit**，它会自己重读结果页并联系"前 N 个"，**没有"指定 offerId 列表"的入参**（源码里没有这个口子，且不许改）。零改源码的可行做法：

1. 先 listTopSellers(N) 拿到 offerId / shopName / sellerNick（纯读，不点击）；
2. 把黑名单命中的**卡片节点从 DOM 里摘掉**（card.remove()）；
3. 再调 contactTopSellers({limit, skipSent, campaignId})；
4. 联系结果逐个回查黑名单，命中就记 blocked，**回复层照旧排除**。

缺点：结果页若重渲染，卡片会回来 → 所以每次联系前都重新摘一遍。
备选（更稳但会写"脏数据"）：把黑名单商家的 offerId 预先写进 image_contacts（带 status='blocked'），利用现有 skipSent 过滤生效；代价是这张表混入"其实没联系"的记录。

**默认采用"DOM 预过滤 + 回复层排除"**；实测若重渲染频繁，再切备选。

---

## 九、任务列表（分批验收）

### P0 · 打通一条完整链路（做完即可演示）
| # | 任务 | 产出 | 验收标准 |
|---|---|---|---|
| P0-1 | **桥接脚本**（新增文件） | tools/api/bridge.mjs | node bridge.mjs --list 列出全部命令；发一条命令拿到 JSON 结果；console.log 全部改道 stderr，不污染协议 |
| P0-2 | **Python 桥接客户端** | tools/api/bridge.py | 常驻、异步锁、超时、崩溃自动重启；连续 100 次调用无泄漏 |
| P0-3 | **FastAPI 骨架** | tools/api/main.py | /docs 可打开；统一响应与错误码 |
| P0-4 | **只读数据通道** | tools/api/repo.py | 比价/报价/客户/聊天/统计 全部可查（纯 SELECT） |
| P0-5 | **核心业务接口** | /campaigns 系列 | 用 API 建任务 → 搜图 → 出比价表，全程不碰命令行 |
| P0-6 | **串行队列 + 流程启停** | tools/api/queue.py | 队列可见可停；monitor/bridge 启停准确（含崩溃识别） |

### P1 · 业务可用
| # | 任务 | 验收标准 |
|---|---|---|
| P1-1 | 发送接口（text/phrase/image/reply，**真实发送**） | 前端点一下真能发出去，且落 phrase_sends / auto_replies |
| P1-2 | 单步推进 advance 接入队列 | 队列轮转多任务，互不串会话、互不抢窗口 |
| P1-3 | 短语库 / 图片库 CRUD + 绑定 | 前端能维护"图片 ↔ 短语"对应关系 |
| P1-4 | 参数设置 + 黑白名单 + 终止追踪 | 名单生效：黑名单客户 0 回复；放弃后不再追问 |
| P1-5 | AI 接口 | 前端能对指定回复做解析预览、生成追问话术 |
| P1-6 | 系统状态接口 | 首页仪表盘数据全部真实可刷 |

### P2 · 上生产
| # | 任务 | 验收标准 |
|---|---|---|
| P2-1 | 认证（API Key）+ 审计表 + 全局限速 | 未带 Key 拒绝；写操作留痕（谁、何时、什么参数、结果） |
| P2-2 | Dockerfile + docker-compose | 一条命令起服务；容器内能连宿主机 9222 |
| P2-3 | 部署 + 排障手册 | 含"Chrome 挂了 / 登录过期 / DB 锁 / 队列卡住"处置步骤 |

### P3 · 增强
| # | 任务 |
|---|---|
| P3-1 | 前端联调契约补充（业务字段说明 + 示例） |
| P3-2 | 定时任务（每日自动 collect + reparse） |
| P3-3 | bridge --with-monitor 单进程形态；多浏览器 worker |

---

## 十、待确认（我已按下面默认假设推进，任一条否决即可）

| # | 事项 | 我的默认假设 |
|---|---|---|
| 1 | Chrome 与 im.db 位置 | **都留宿主机**（Windows），容器通过端口连 9222（容器内跑 GUI Chrome 需重新扫码且有风控风险） |
| 2 | 部署环境 | 默认 **Windows 上的 Docker Desktop** → 用 host.docker.internal；若你是 Linux 宿主机，改 --network host |
| 3 | 认证 | 先 **API Key**（Header X-API-Key），后续可插拔换成你现有账号体系 |
| 4 | 发送模式 | 生产**真实发送**（mode='send'）；仅测试环境切 draft（只填草稿等人点发送） |
| 5 | 接口风格 | 先 **REST**（含分页/导出）；需要实时进度再加 SSE/WebSocket |
| 6 | 桥接文件 | 允许在 tools/api/ **新增** bridge.mjs（不动 tools/qianniu/**） |
| 7 | im.db 只读优化 | 默认**不加任何索引**；消息量大了再单独找你要授权（只加索引、不改表结构） |
| 8 | P0 完成后谁跑 | 由我在宿主机起服务给你联调 |

**另外需要你授权一次**：Python 运行时缺 fastapi / uvicorn（pydantic、sqlite3 已有），P0-3 需要装这两个包。

---

## 十一、风险与对策

| 风险 | 对策 |
|---|---|
| 阿里风控（真实发送） | 沿用已有护栏：最小间隔 / 每小时上限 / 免打扰 / 去重窗口；建议业务侧先小批量试跑 |
| 登录态过期 | /system/health 检测登录态，过期即拒绝发送并提示人工扫码 |
| 监听刷新打断操作 | 规则 1：--refresh 0 + 由队列在空闲点刷新 |
| 监听绕过名单自己发消息 | 规则 2：监听不带 --rules，自动回复全部由队列驱动 |
| SQLite 并发写 | Node 侧已开 WAL + busy_timeout；**Python 一律只读**，写操作全部走桥接。注意：WAL 库**不能**用 ?mode=ro 打开（会失败），要用普通连接 + 只发 SELECT |
| 结果页重渲染导致 DOM 过滤失效 | 每次联系前重新过滤 + 回复层兜底排除（§8.2） |
| 桥接进程崩溃 | 客户端自动重启 + 状态接口识别 crashed + 退出码 |
| 遗留 node 进程 | 上生产前确认后清理 3 个 9/22 的残留进程 |
