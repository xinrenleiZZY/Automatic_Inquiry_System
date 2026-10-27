# Automatic_Inquiry_System · 系统设计与技术栈方案

> 状态：**待审核**（本文档只做设计，未写实现）
> 上游依赖：`tools/qianniu/**` 为**冻结源码**（一行不改），本系统只能通过「冻结入口 + CLI + 新增桥接脚本」调用它
> 配套文档：`tools/api/PLAN.md`（接口层方案 v2）
> ⚠️ 2026-10-15 变更：AI 解析从单阶段改成两阶段 + 证据自检 + 复核队列，为落地该改动，
> `tools/qianniu` 里的 `blocks/ai.mjs`、`blocks/auto-reply.mjs`、`blocks/db.mjs`（+ 新增
> `sop-requirements.json`、`probe-ai-parse.mjs`）已按业务方要求直接修改，**不再是"一行不改"**。
> 浏览器自动化层（session/input/monitor/注入/搜图）仍然未动。桥接协议向后兼容，Python 侧无需改动。

---

## 一、先定三个约束（所有选型都由它们推导）

| # | 约束 | 推导出的结论 |
|---|---|---|
| **C1** | Chrome 必须跑在 Windows 宿主机（1688 登录态、风控环境），且**只能有一个实例**（同账号多开会被踢） | **浏览器是全局串行独占资源** → 系统吞吐上限由它决定，不由 Web 框架决定 → **不需要 Redis / Celery / 消息队列 / K8s** |
| **C2** | `im.db` 是 Node 侧事实库，WAL 模式，写在 Windows 本地磁盘 | **禁止跨操作系统挂载后读写**（WAL 依赖共享内存 `-shm`，容器 bind mount 上不可靠）→ 决定部署形态（见 §4） |
| **C3** | 用户是内网业务人员（个位数），不是公网量级 | 认证/限流/多租户可以轻量；**上 Postgres、上集群、上微服务都是负收益** |

---

## 二、总体分层

```
┌──────────────────────────────────────────────────────────────┐
│ L1 展示层   浏览器 SPA（8 个页面）                             │
│             仪表盘 / 任务列表 / 比价表 / 客户中心 /            │
│             客户管理 / 参数设置 / 图片库 / 快捷短语             │
└───────────────────────────┬──────────────────────────────────┘
                            │ REST/JSON（轮询 5s；可选 SSE）
┌───────────────────────────▼──────────────────────────────────┐
│ L2 应用层   FastAPI                                           │
│   ├─ 路由层  routers/   参数校验、权限、响应包装                │
│   ├─ 串行队列 queue.py  **唯一仲裁者**：浏览器操作排队执行       │
│   ├─ 流程 flows.py      monitor 启停、空闲点刷新、定时任务      │
│   └─ 只读查询 repo/     比价/报价/客户/聊天/统计（纯 SELECT）    │
└──────┬──────────────────────────────┬────────────────────────┘
       │ 操作（需串行）                 │ 查询（只读）
┌──────▼───────────────┐   ┌──────────▼───────────────────────┐
│ L3 通道层            │   │ 数据层                            │
│  Node 桥接（新增文件）│   │  im.db  事实库（Node 写 / Py 读）  │
│   → blocks/index.mjs │   │  api.db 配置·名单·用户·审计（Py）  │
└──────┬───────────────┘   └──────────────────────────────────┘
       │
┌──────▼───────────────────────────────────────────────────────┐
│ L4 执行层   tools/qianniu/**  +  Chrome 152（CDP 6901）       │
│             常驻 monitor（15s 轮询入库）                       │
└──────────────────────────────────────────────────────────────┘
```

---

## 三、技术栈推荐

### 3.1 前端（主选）

| 层 | 选型 | 理由 |
|---|---|---|
| 框架 | **React 18 + TypeScript** | 8 个页面里 6 个是"表格 + 表单 + 抽屉"，React 生态的表格/虚拟滚动最成熟 |
| 构建 | **Vite** | 秒级热更新，构建产物是纯静态文件，容器/原生都随便放 |
| UI 组件 | **Ant Design 5** | Table / Form / Drawer / Descriptions / Upload 开箱即用；和 1688 后台同一视觉语言，业务人员零学习成本 |
| 请求/缓存 | **TanStack Query** | 轮询（仪表盘 5s、任务 5s）一行配置；自动重试、失效刷新、加载态全部内置 |
| 全局状态 | **Zustand** | 只有"当前用户/全局筛选条件"这点状态，Redux 是过度设计 |
| 图表 | **ECharts** | 仪表盘 + 比价趋势；中文文档齐全 |
| 表格增强 | AntD Table（内置虚拟滚动）+ 列固定/导出 | 比价表可能上千行 |

**备选**：Vue 3 + Element Plus + Pinia。功能等价，**若你们团队是 Vue 栈我就换**，页面结构 1:1 对应，不损失任何能力。

### 3.2 后端（主选）

| 层 | 选型 | 理由 |
|---|---|---|
| 语言/运行时 | **Python 3.12** | 宿主机已就绪（pydantic、sqlite3 都有） |
| Web 框架 | **FastAPI + Uvicorn** | 自带 OpenAPI（前端可直接看 `/docs` 联调）；异步天然适配"长耗时浏览器操作" |
| 校验/序列化 | **Pydantic v2** | 已装；接口契约单一来源 |
| 数据库 | **sqlite3 标准库**（只读）+ `api.db`（读写） | im.db 只发 SELECT；系统自身的配置/名单/用户/审计放**独立** api.db，物理隔离 |
| 调度 | **自研 asyncio 单 worker 队列** | 见 §3.4，这是本系统最关键的一条 |
| 子进程 | `subprocess` + PID/日志/心跳三重存活判定 | 管现有 `monitor`（冻结源码，不改） |
| 认证 | **JWT**（或会话 Cookie）；角色 admin / operator / viewer | C3，内网够用 |
| 定时 | APScheduler（**可选**，仅"每日 collect/reparse"这类） | 不引入独立调度服务 |

### 3.3 通道层与数据层

| 项 | 选型 | 说明 |
|---|---|---|
| 桥接脚本 | Node（**新增文件**，import 冻结入口 `blocks/index.mjs`） | 不碰 `tools/qianniu/**` 任何一行 |
| 桥接协议 | v1：stdio JSON-line；v2：`127.0.0.1:<port>` HTTP | `{id, cmd, args}` → `{id, ok, data, error, elapsed_ms}`；`console.log` 全部改道 stderr，不污染协议 |
| 事实库 | im.db（15 张表，Node 写） | 系统**只读** |
| 系统库 | api.db | settings / whitelist / blacklist / drop_list / users / api_audit |

### 3.4 为什么"调度"要自研单 worker 队列，而不是 Celery/Redis

这是全案最重要的一个判断：

- 约束 C1 决定了**并发度恒为 1**——同时只能有一个浏览器操作在跑。既然并发度是 1，队列的"消费者"就是一个协程，Celery/Redis 提供的并行消费能力**在这里完全用不上**。
- 我们真正需要的三件事是 **排队 / 可观测 / 可暂停**：
  - 排队：`asyncio.Queue` + 单 worker
  - 可观测：队列深度、当前执行项、每个任务的耗时与结果 → 前端"流程控制台"
  - 可暂停：`pause` 事件 + 每个动作前检查一次
- 引入 Redis/Celery 的代价：多一个进程、多一份状态、多一个故障点、Windows 上还要额外折腾；**收益为零**。

同理不引入：**Kafka/RabbitMQ**（无跨机需求）、**K8s**（单机）、**Postgres**（单机写少读多，SQLite 足够）、**Elasticsearch**（消息量几千级，SQL LIKE 够用）。

### 3.5 部署形态

> 这是 C2 逼出来的唯一分叉点，需要你选一个。

| | **A. v1 全原生 Windows（推荐先做）** | **B. v2 混合（容器 + 宿主机）** | C. 全容器（含 Chrome） |
|---|---|---|---|
| 宿主机 | Chrome + monitor + bridge + Python API + 前端 | Chrome + monitor + bridge(HTTP) + im.db | 只留 Docker |
| 容器 | — | api 容器 + web(Nginx) 容器 | Chrome + Node + API + Web |
| 报表数据 | Python 直读 im.db（零风险，同盘） | **不直读**：① 走 bridge 只读查询接口，或 ② 每 30s `VACUUM INTO` 一份快照给容器读 | 同 B |
| 优点 | 一条链路最短、零跨系统问题、调试最快 | 前后端可标准化交付、可版本化、后端可迁服务器 | 看起来最"云原生" |
| 缺点 | 交付不够"标准化" | 多一跳；SQLite 不能跨挂载读写 | **Chrome 每次重新扫码 + 风控识别容器环境 + 镜像巨大** |
| 结论 | **P0/P1 用它** | **P2 上生产再用** | ❌ 不推荐 |

**已实现的混合路线：** API + Web 在容器；Chrome、monitor、Node bridge、`im.db` 留在
Windows 宿主。宿主控制代理监听 `:7400`，容器用 `host.docker.internal:7400` 调用。
容器不直接读 WAL 数据库，而是读取代理生成并校验过的 `im.db` 快照。代理用
`HOST_AGENT_TOKEN` 认证，并且仍只允许一个 API 实例。

---

## 四、接口契约（前后端唯一真相）

FastAPI 自动产出 OpenAPI，前端从 `/openapi.json` 生成 TS 类型（`openapi-typescript`），**不手写接口类型**。

统一响应：

```json
{ "ok": true, "data": {}, "error": null, "elapsed_ms": 12 }
```

分页统一：`?page=1&size=50` → `{ items, total, page, size }`。

长耗时动作统一返回**任务号**（不是阻塞等结果）：

```
POST /campaigns/3/launch  → 202 { job_id: "j_8f3a", queue_pos: 2 }
GET  /jobs/j_8f3a          → { status: running|done|failed, progress, log_tail }
```

这条很重要：搜图+联系一家要几十秒到几分钟，HTTP 同步等会超时、前端会白屏。

---

## 五、业务页面的前端要点

| 页面 | 关键交互 | 技术要点 |
|---|---|---|
| 首页仪表盘 | 5s 轮询刷新状态卡 + 最近事件流 | TanStack Query `refetchInterval`；ECharts 出"今日发送/回复"趋势 |
| 任务列表 | 任务卡片/表格、阶段进度条、启停、单步推进 | 阶段用 Steps 组件；推进动作走 job 轮询 |
| 比价配置方案 | 业务参数模板 CRUD；新建任务一键套用 | 模板存 `api.db.pricing_templates`（最多 100 套），任务级参数仍可覆盖 |
| 比价表 | 多条件筛选（时间区间/商品/任务）、页面价 vs 回复价对照、超标高亮、导出 | AntD Table（虚拟滚动 + 列固定）；导出走后端 CSV 流 |
| 客户中心 | 客户列表 + 右侧抽屉显示完整往来 | 抽屉内按时间轴渲染 messages；支持"只看对方/只看我方" |
| 客户管理 | 白/黑名单维护、终止追踪（带适用范围：全部任务 / 指定任务） | 批量导入文本域（一行一个旺旺号）；操作即时生效并提示 |
| 参数设置 | 分组表单 + 保存 | 与 `/settings` 一一对应；保存后提示"下一轮生效" |
| 图片库 | 上传/删除、同步、与短语绑定 | AntD Upload；缩略图墙 + 绑定下拉 |
| 快捷短语 | 增删改查（文字+图）、启停用 | 图文成对编辑；预览渲染成"两条消息"的样子 |

### 5.1 「会话 × 任务」两维模型（重要）

同一家商家可能"任务一的这款做不了、任务二的另一款能做"，所以凡是**按客户下的业务结论**都带任务维度：

| 数据 | 维度 | 说明 |
|---|---|---|
| `supplier_quotes`（im.db）报价/状态/追问轮次 | **（会话 × 任务）** | 一行 = 一家商家在一个任务里的报价与状态；`campaign_id=0` 表示无任务的手动流程。判"不做此款"只影响该任务 |
| `ai_calls`（im.db）AI 调用留痕 | request_id | 每次 DeepSeek HTTP 调用记录完整提示词、模型响应、token、耗时、错误和任务/会话/作业关联 |
| `customer_flags`（api.db）白/黑/放弃名单 | **（会话 × 任务）** | `campaign_id=0` = 全部任务（对所有任务生效）；`>0` = 只对该任务生效。**任务级覆盖全局级**（所以全局"放弃"可以让某个任务"白名单翻案"） |
| `auto_replies` 已处理消息指纹 | 取"本任务内已处理" | 任务一处理过的消息不会挡住任务二继续追问 |

生效判定：`store.flags_map(campaign_id)`（任务级优先）→ `allowed_conv_keys()` / `handlers._contact_filters()`；
报价用 `db.latestQuote(db, convKey, campaignId)` 读。接口上：`/api/data/customers?campaign_id=`、
`/api/data/chat?campaign_id=`、`/api/settings/lists?campaign_id=`、名单增删都接受 `campaign_id`。

---

## 六、非功能设计

| 维度 | 方案 |
|---|---|
| **可靠性** | 每个浏览器动作**可重入**：失败 → 记录 → 重试 N 次 → 仍失败则把该客户标"需人工"。绝不因为一次失败卡死整条队列 |
| **幂等** | 发送动作带 `client_token`，重试时先查 im.db 是否已发送成功（复用现有 `phrase_sends` / `auto_replies` 记录） |
| **可观测** | ① 结构化日志落文件并可按 job_id 过滤 ② 心跳表直接读 ③ 前端"流程控制台"显示队列深度/当前动作/耗时 |
| **性能** | 报表查询走本地 SQLite（毫秒级）；前端轮询 5s；比价表分页 + 索引（如需索引另行申请） |
| **安全** | JWT + 角色；写操作入 `api_audit`（谁/何时/参数/结果）；真实发送接口限 admin+operator |
| **风控** | 复用已有护栏：最小间隔 / 每小时上限 / 免打扰 / 去重窗口；前端在"参数设置"里可调 |
| **备份** | 每日 `VACUUM INTO` 一份 im.db + api.db 到 `backups/yyyy-mm-dd/`（顺带解决 B 方案的快照需求） |
| **排障** | 手册覆盖：Chrome 掉了 / 登录过期 / 队列卡住 / DB 锁 / 桥接崩溃 五类 |

---

## 七、仓库结构

```
Automatic_Inquiry_System/
├─ backend/
│  ├─ app/
│  │  ├─ main.py             FastAPI 入口（挂路由、CORS、异常处理）
│  │  ├─ config.py           路径/端口/开关（DB 路径、bridge 命令、Chrome 端口）
│  │  ├─ deps.py             auth、db 连接、队列句柄
│  │  ├─ bridge.py           Node 桥接客户端（常驻、超时、崩溃重启）
│  │  ├─ queue.py            单 worker 串行队列 + job 表
│  │  ├─ flows.py            monitor 启停、空闲点刷新、定时任务
│  │  ├─ repo/               只读查询：compare / quotes / customers / chat / stats
│  │  ├─ store.py            api.db：settings / 名单 / 用户 / 审计
│  │  ├─ routers/            system · campaigns · send · outreach · data · library · settings · flows
│  │  └─ models.py           Pydantic 契约
│  └─ pyproject.toml
├─ bridge/
│  └─ bridge.mjs             ★ 新增文件，import ../../tools/qianniu/blocks/index.mjs
├─ frontend/
│  ├─ src/pages/             dashboard · campaigns · compare · customers · customer-admin · settings · images · phrases
│  ├─ src/api/               openapi-typescript 生成的类型 + 请求封装
│  └─ package.json
├─ deploy/
│  ├─ docker-compose.yml     api + web（P2）
│  ├─ Dockerfile.api · Dockerfile.web · nginx.conf
│  └─ start-native.ps1       v1 原生一键启动（P0）
├─ backups/
└─ docs/
```

**注意**：`bridge/` 放在本系统目录内（不放 `tools/qianniu/`），确保冻结源码目录**零新增、零修改**。

---

## 八、落地路线

| 阶段 | 内容 | 产出 |
|---|---|---|
| **P0** 打通 | bridge + Python 桥接客户端 + FastAPI 骨架 + 只读查询 + 任务 CRUD + 串行队列 | 用 API 建任务→搜图→出比价表，全程不碰命令行 |
| **P1** 业务可用 | 发送接口（真实发送）、黑白名单、参数设置、库 CRUD、AI 接口 | 8 个页面全部有真实数据 |
| **P2** 上生产 | 认证+审计、容器化、备份、排障手册 | 容器应用层 + Windows 宿主控制代理；`:7400` 控宿主，快照读 `im.db` |
| **P3** 增强 | 定时任务、`bridge --with-monitor` 单进程形态、多浏览器 worker | 按需 |

---

## 九、需要你拍板

| # | 事项 | 我的建议 |
|---|---|---|
| 1 | 部署形态 | **v1 原生 Windows 先跑通，P2 再容器化**（C2 决定的） |
| 2 | 前端技术栈 | **React + Ant Design**；若你们团队是 Vue 栈，我换成 Vue 3 + Element Plus |
| 3 | 业务人员数量与角色 | 需要几个账号？是否分 admin/operator/viewer？（影响认证复杂度） |
| 4 | 是否要"人工二次确认"开关 | 生产默认真发；但建议保留一个全局开关，风控紧张时一键切 draft |
| 5 | 实时性要求 | 仪表盘 5s 轮询够不够？需要秒级再上 SSE |
| 6 | 是否需要开机自启 | 建议做成 Windows 计划任务：开机拉起 Chrome(6901) + monitor + API |
