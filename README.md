# 自动询价系统（Automatic Inquiry System）

> 1688 比价议价的统一工作台：**以图搜图 → 自动询价 → 收集报价 → 出比价表**
> 版本：V1.0 · 技术栈：FastAPI + React 18 + Ant Design 5 + Node 桥接 + Chrome CDP

---

## 一、这是什么

一套给业务人员用的**内部系统**，把已经跑通的 1688 自动化能力（冻结在 `tools/qianniu/**`）
包成 **HTTP 接口 + 可视化前端**，并提供「流程启停、参数配置、客户名单、数据报表」。

三句话讲清架构：

1. **Python 只写接口层**：REST 接口 + 单 worker 串行队列 + 只读报表查询；
2. **浏览器动作全部交给冻结的 Node 功能区块**，Python 通过一个新增的桥接脚本
   （`tools/api/bridge.mjs`）调用它们，**没有改动 `tools/qianniu/**` 任何一行源码**；
3. **三个关键决策留在宿主机**：Chrome 与登录态、`im.db`、单浏览器实例。

完整设计见 [ARCHITECTURE.md](./ARCHITECTURE.md)。
当前运行态、任务与数据状态见 [项目当前状态](./docs/项目当前状态.md)。

---

## 二、目录结构

```
Automatic_Inquiry_System/
├── backend/                     FastAPI 接口层
│   ├── main.py                  入口（含前端静态托管 + SPA 兜底路由）
│   ├── app/
│   │   ├── config.py            全部配置（环境变量可覆盖）
│   │   ├── security.py          JWT 验签 + 角色守卫
│   │   ├── bridge.py            Node 桥接客户端（常驻、超时、崩溃重启）
│   │   ├── queue.py             单 worker 串行队列（全系统唯一浏览器仲裁者）
│   │   ├── handlers.py          作业处理器（作业 → 桥接调用）
│   │   ├── repo.py              只读查询 im.db（比价表/客户/聊天/统计）
│   │   ├── store.py             自己的库 api.db（参数/名单/作业/审计）
│   │   └── api/                 路由：auth system settings campaigns flows send outreach data library ai
│   ├── tests/smoke_api.py       接口层冒烟测试（只读、无副作用）
│   └── requirements.txt
├── frontend/                    React 18 + Vite + Ant Design 5
│   └── src/
│       ├── App.tsx / nav.tsx    路由与菜单
│       ├── components/          AppLayout / StatCard / Chart / JobRunner
│       ├── pages/               9 个业务页面 + 登录页
│       ├── api/                 axios 封装（401 → 门户登录）与类型
│       ├── auth/                AuthContext（登录态、角色）
│       └── utils/format.ts      时间/金额/口径/状态格式化
├── deploy/
│   ├── start-native.ps1         原生 Windows 一键启动/停止/状态
│   ├── browser-control.ps1      1688 调试实例（Chrome）启停/进程探测（状态监控页用）
│   ├── Dockerfile               单容器镜像（前端 + API + Node 桥接）
│   └── docker-compose.yml       容器编排（P2 可选）
├── docs/
│   ├── 部署与接入.md             门户 SSO 接入、部署步骤、排障手册
│   └── 测试报告.md              测试结果与已修问题
├── .env.example                 环境变量模板
└── data/                        运行数据：api.db、日志（不进版本库）
```

---

## 三、快速开始（原生 Windows，推荐）

```powershell
# 0. 前置：Node >= 22、Python 3.12、Chrome 以调试端口启动并登录 1688
#    （Chrome 与常驻监听由 tools/qianniu/start-im.ps1 负责拉起）

# 1. 装依赖（只做一次）
python -m pip install -r backend\requirements.txt
cd frontend; npm install; cd ..

# 2. 配置
copy .env.example .env      # 至少改 JWT_SECRET / PORTAL_API_BASE_URL / SSO_CALLBACK_URL

# 3. 一键启动（会自动构建前端）
.\deploy\start-native.ps1 -WithMonitor

# 4. 打开
#    http://127.0.0.1:6900          业务界面
#    http://127.0.0.1:6900/docs     接口文档（OpenAPI）
```

停止：`.\deploy\start-native.ps1 -Stop`
查看状态：`.\deploy\start-native.ps1 -Status`

### 容器应用层 + Windows 宿主控制代理

容器模式把 React、FastAPI、队列和业务逻辑放进 Docker；Chrome、1688 登录态、
Node bridge、常驻监听和 `im.db` 留在 Windows 宿主机。容器通过带令牌的宿主代理访问
这些能力，并读取代理生成的稳定数据库快照，不再直接挂载 WAL 数据库。

```powershell
cd E:\ZY2026\cg_002-26.9.17-1688比价议价\Automatic_Inquiry_System

# 必须在当前用户自己的桌面会话中启动，代理才能拉起 Chrome
.\deploy\start-host-agent.ps1

# 推荐：注册登录自启，并在代理退出后每 5 分钟自动拉起
.\deploy\install-host-agent-autostart.ps1

# --env-file 让 Compose 读取本目录的 .env
docker compose --env-file .env -f .\deploy\docker-compose.yml up -d --build
```

宿主代理首次启动会自动生成 `HOST_AGENT_TOKEN` 并写入 `.env`。代理默认监听
`0.0.0.0:7400`，只应向 Docker/可信内网开放，不要直接暴露到公网。

```powershell
# 代理状态
.\deploy\start-host-agent.ps1 -Status

# 停止容器和代理；停止容器不会顺带关闭浏览器或监听
docker compose --env-file .env -f .\deploy\docker-compose.yml down
.\deploy\start-host-agent.ps1 -Stop
```

容器模式仍然是**单 API 实例**，不要用 Docker 副本扩容：串行队列是进程内队列，
多个 API 会同时争抢同一个 Chrome 和 1688 登录态。

### 端口约定（2026-09-29 调整）

| 端口 | 用途 | 旧值 | 改在哪 |
|---|---|---|---|
| **6900** | 业务界面 + API（同源） | 6690 | `.env` 的 `APP_PORT`（唯一配置点，前端/SSO回调/启动脚本/开发代理全跟着走） |
| **6901** | Chrome CDP 调试端口 | 9222 | `.env` 的 `CDP_BASE` + `tools/qianniu/start-im.ps1` 的 `-CdpPort` 参数 |
| 6905 | Vite 开发服务器（仅 `npm run dev`） | 5190 | `frontend/vite.config.ts` |
| **7400** | Windows 宿主控制代理（仅容器模式） | — | `.env` 的 `HOST_AGENT_PORT` |

> 本机 Docker 已占用：5433、7500-7502、7600-7602、7609、7640、7701、8173、8800、9100、9101、9201、9202、9290、9525、9528、9543。
> 新端口段 6900-6905 实测无冲突。

---

## 四、登录方式

| 方式 | 说明 |
|---|---|
| **企业门户 SSO（生产）** | 登录页点「企业门户登录」→ 跳门户 → 门户按 redirect 反查应用并校验权限 → 回跳带一次性 code → 本应用服务端换 token 写入 HttpOnly cookie |
| **本地调试登录** | `admin/admin123`、`gm/gm123`、`user/user123`。**生产请把 `.env` 里 `ALLOW_DEV_LOGIN=false` 关掉** |

角色（来自门户 JWT 的 `roles`）：

| 角色 | 能力 |
|---|---|
| `admin` | 全部页面 + 参数设置 + 客户管理 + 流程启停 |
| `gm` | 同上（除用户体系相关） |
| `user` | 仪表盘 / 任务列表 / 比价配置方案（只读）/ 比价表 / 客户中心 / 图片库 / 快捷短语 |

---

## 五、业务页面

| 页面 | 路径 | 内容 |
|---|---|---|
| 首页仪表盘 | `/` | 客户数/消息数/任务数/已联系商家/报价条数、组件健康、近 14 天消息量、最近事件、队列状态 |
| 状态监控 | `/monitor` | **一键启停**（浏览器 + 常驻监听 + 串行队列）；检测 Chrome 是否打开、1688 账号是否登录、登录态是否有效、聊天页/搜索页/结果页是否打开；**Chrome 路径可配置**；**1688 自动登录**（机器切页签+填账号密码+点登录+自动拖一次滑块，短信验证码留给人） |
| 任务列表 | `/campaigns` | 任务 CRUD、阶段进度、启动（含自愈补发）/采集/自动采集/**全自动比价**/推进/补发/暂停/归档、推送飞书、下载比价表 CSV、收敛标签页、刷新聊天页 |
| 比价配置方案 | `/pricing-templates` | 最多 100 套业务参数模板，保存发送模式、询价客户数量、同时处理会话数、预期价格要求、超时追问次数、任务最长运行时长和每客户超时判定；新建任务时可一键套用 |
| 比价表 | `/compare` | 按任务/商品/时间区间筛选，页面价 vs 真实报价；支持“详细 / 简洁”切换；简洁表归一化起订量、运费、工期、退款、次品率和保密协议；可导出双工作表 Excel 或详细/简洁 CSV |
| 客户中心 | `/customers` | 客户台账 + 单客户完整往来；按任务直观显示“待回复 / 信息已集齐 / 不做此款 / 信息不全 / 需人工联系”及原因，支持结果筛选；集齐后自动回复客户“已收到，请稍候” |
| 客户管理 | `/customer-admin` | 白名单 / 黑名单 / 放弃名单，终止追踪与恢复 |
| 图片库 | `/images` | 图片增删改查、文件夹同步、与快捷短语绑定 |
| 快捷短语 | `/phrases` | 文字+图片短语的增删改查 |
| 参数设置 | `/settings` | 询价客户数量、全局上限、预期价格、同时处理会话数（队列轮转粒度）、发送间隔/每小时上限/免打扰、刷新间隔 |

---

## 六、接口清单

统一前缀 `/api`。错误响应沿用门户风格：`{"detail": "..."}`（401 未登录、403 无权限、422 参数非法、400 业务拒绝）。

### 认证 `/api/auth`
`GET /config` `GET /sso-redirect` `GET /sso/callback` `GET /me` `POST /logout` `POST /dev-login`

### 状态监控 `/api/browser`
`GET /status`（体检快照）`POST /probe`（深度体检：读一次聊天页）
`POST /start`（一键启动：浏览器→监听→队列）`POST /stop`（一键停止：监听→浏览器）
`POST /chrome/start` `POST /chrome/stop`（只动浏览器）`POST /open`（打开聊天页/工作台，走队列）`GET /logs`
`GET /chrome-path`（当前生效的 chrome.exe 路径 + 来源 + 自动检测候选）`PUT /chrome-path`（设置路径，传空串 = 恢复自动检测）
`GET /login-info`（账号 + 密码有没有存，**永不回显密码**）`PUT /login-credentials`（保存/清除凭证）
`POST /login`（一键登录：走队列，凭证在执行时才从 settings 取，不进作业参数）
`GET /api/system/ai-calls`（AI 调用留痕：提示词、响应、token、耗时、任务/会话/作业关联）

> 登录边界：切「密码登录」页签 → 填账号密码（**保存了凭证就以保存的为准**，覆盖 Chrome 预填的旧值）→ 点登录 →
> 把登录页切到前台 → **通过真实鼠标事件自动拖动一次滑块**；滑块失败或出现短信验证码时再交回人工；
> 阿里风控页在跨域同源 iframe（`_____tmd_____/punish`）里，检测会连同源 iframe 一起看，所以能报出"卡在滑块验证"。
> 凭证只存本机 `api.db` 的 `settings`（`login_password` 属 `store.SECRET_SETTINGS`，
> `/api/settings` 与 `/api/system/config` 都会过滤掉）。

> 判定口径：`1688 登录态` = 会员 cookie（`unb`/`aui`/`_nk_`…）
> **且**服务端带着这堆 cookie 请求工作台时没有被重定向到登录页
> **且**浏览器里没有被重定向到登录页的标签页。三者取"最小可信"结论，
> 所以"cookie 还在但会话早被踢了"这种情况也会被判成未登录。

### 系统 `/api/system`
`GET /health` `GET /status` `GET /commands` `GET /config` `GET /logs` `GET /audit` `GET /events`（另有无鉴权的 `GET /api/health` 供健康检查）

### 任务 `/api/campaigns`
`GET /` `POST /` `GET /{id}` `PUT /{id}` `DELETE /{id}`（归档）
`POST /{id}/launch` `POST /{id}/collect` `POST /{id}/advance` `POST /{id}/pause` `POST /{id}/resume`
`POST /{id}/resend`（补发没发成功的询价短语）
`POST /{id}/autocollect`（自动采集：每个客户独立计时；回复立即入队并做 AI 问答；超时最多主动追问 2 次，之后静默等待；任务持续到运行时长或手动停止；可选发送会话表）
`POST /{id}/fullauto`（全自动比价：启动 → 自动采集 → 飞书推送比价表总结 + 比价表 CSV）
`GET /{id}/price-report`（比价表总结预览 + 飞书配置状态）`GET /{id}/price-report.csv`（比价表 CSV 下载）`POST /{id}/feishu`（手动推送飞书）
`GET /{id}/report` `GET /{id}/contacts`

### 流程与作业 `/api/flows` `/api/jobs`
`GET /flows` `POST /flows/monitor/start|stop` `GET /flows/monitor/status` `POST /flows/monitor/once`
`POST /flows/queue/start|stop|pause|resume|tick` `POST /flows/refresh` `POST /flows/tabs/enforce`
`GET /jobs` `GET /jobs/{id}` `POST /jobs/{id}/cancel`

### 发送 `/api/send`
`GET /mode` `POST /text` `POST /phrase` `POST /image` `POST /reply/run`
（真实发送默认要求请求体带 `confirm=true`）

### 搜图与联系
`POST /api/search/image` `GET /api/search/recent` `GET /api/outreach/sellers` `POST /api/outreach/contact` `GET /api/outreach/contacts`

### 数据 `/api/data`
`GET /stats` `GET /compare` `GET /quotes` `GET /customers` `GET /chat` `GET /messages`
`GET /offers` `GET /image-searches` `GET /image-contacts` `GET /phrase-sends` `GET /auto-replies`
`GET /heartbeats` `GET /export/{compare|quotes|customers}.csv`

### 库与 AI
`GET|POST /api/phrases` `PUT|DELETE /api/phrases/{id}`
`GET /api/library/images` `POST /api/library/images/sync|bind|upload` `DELETE /api/library/images` `GET /api/library/file`
`GET /api/ai/config` `POST /api/ai/parse` `POST /api/ai/compose`

### 参数与名单
`GET|PUT /api/settings` `GET|POST /api/settings/lists` `DELETE /api/settings/lists/{conv_key}`
`POST /api/customers/{conv_key}/drop` `POST /api/customers/{conv_key}/restore`

---

## 七、安全与边界

- **零改源码**：`tools/qianniu/**` 一行未动；桥接 `bridge.mjs` 是新增文件，只 `import` 冻结入口。
- **单一写者**：`im.db` 只由 Node 侧写入；Python 用 `mode=rw` + `PRAGMA query_only=ON` 打开，**只发 SELECT**。
- **浏览器独占**：所有会动浏览器的动作都进同一条队列串行执行，绝不同时抢聊天窗口。
- **启停只动调试实例**：关浏览器优先走 CDP `Browser.close`，兜底才按进程关，且只认
  「占用 6901 端口的进程」或「命令行里带 `--user-data-dir=<1688-cdp-profile>` 的 chrome.exe」，
  日常那个 Chrome 不会被误伤；有作业正在执行时拒绝关闭（要强制得显式传 `force`）。
- **真实发送有闸**：`REQUIRE_SEND_CONFIRM=true` 时，发消息接口必须带 `confirm=true`。
- **路径穿越防护**：图片预览/删除只允许落在图片库目录内。
- **审计**：写操作全部落 `api.db` 的 `audit` 表（谁、何时、什么参数、结果）。
- **AI 留痕**：每次 DeepSeek 调用落 `im.db` 的 `ai_calls` 表，图片 data URL 只留占位符；日志中心「AI 调用」页可展开查看完整 prompt 与响应。
- **结果页自愈**：任务联系商家前会检查对应 `imageId` 的结果页；标签被关闭或浏览器重启后会直接用已保存的 `imageId` 重放，并等待商品卡片渲染完成。

---

## 八、文档索引

| 文档 | 说明 |
|---|---|
| [ARCHITECTURE.md](./ARCHITECTURE.md) | 系统设计与技术栈选型（含为什么不上 Redis / K8s） |
| [docs/部署与接入.md](./docs/部署与接入.md) | 门户 SSO 接入步骤、部署、迁移、排障手册 |
| [docs/测试报告.md](./docs/测试报告.md) | 接口冒烟测试（40/40）、前端页面验收、已修问题清单 |
| [../tools/api/PLAN.md](../tools/api/PLAN.md) | 接口层方案 v2（零改源码版） |
| [../tools/qianniu/README.md](../tools/qianniu/README.md) | 冻结源码（功能区块）自身文档 |

