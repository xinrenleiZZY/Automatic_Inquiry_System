# 1688 网页版旺旺 · 自动监控与回复（CDP）

> 通过 Chrome DevTools Protocol 操作网页版旺旺，实现**消息监控 + 落库 + 规则回复**。
> 不依赖任何第三方 SDK；只用 Node 内置能力（`node:sqlite`、全局 `WebSocket`/`fetch`）。

---

## 一、聊天页身份（**最重要，别改错**）

聊天窗口就是一个普通 Chrome 页面 target，地址固定：

```
https://air.1688.com/app/ocms-fusion-components-1688/def_cbu_web_im/index.html#/
# 带上下文时形如：...index.html?touid=<对方账号>&offerId=<商品id>&siteid=cnalichn#/
```

它只是**外壳**，真正的聊天界面在同源 iframe 里（三层结构）：

| 层级 | 地址 | 里面有什么 |
|---|---|---|
| TOP | `def_cbu_web_im/index.html` | 空壳，没有输入框 |
| iframe[0] | **`def_cbu_web_im_core/index.html`** | **输入框 / 消息区 / 会话列表 / 发送按钮** |
| iframe[0]>iframe[0] | `kapp/.../ww-bulk-inquiry-modal/assistant` | AI 询盘助手（另一套 UI） |

代码里的常量（`blocks/session.mjs`）：

- `CHAT_PAGE_URL` = 上面的完整地址
- `CORE_FRAME_MARK` = `def_cbu_web_im_core`
- `PAGE_MATCH` = `def_cbu_web_im`（可用环境变量 `IM_MATCH` 覆盖）
- `isChatPage(url)` = 校验函数，自测里会断言"attach 到的确实是聊天页"

---

## 一之二、搜索页身份（以图搜图）

以图搜图的目标页面固定是：

```
https://s.1688.com/selloffer/offer_search.htm
```

点完"搜索图片"后页面会跳到结果页（`air.1688.com` 的 kapp 子应用）：

```
https://air.1688.com/kapp/1688-search/pc-image-search/?tab=imageSearch&imageId=<图片ID>
```

代码常量（`blocks/image-search.mjs`）：

| 常量 | 值 / 用途 |
|---|---|
| `SEARCH_PAGE_URL` | `https://s.1688.com/selloffer/offer_search.htm` |
| `SEARCH_BTN_SELECTOR` | `#pc-home2024-search-tab > div > div.image-input-button > div > div.copy-image-container > div.search-btn`（文本"搜索图片"） |
| `IMAGE_FILE_INPUT` | `input.image-file-reader-wrapper`（`accept=.jpg,.jpeg,.png,.bmp,.webp`）**可直接塞文件** |
| `RESULTS_MATCH` | `['pc-image-search', 'offer_search']` |
| `imageSearchUrl(id)` | 用 `imageId` 直接拼结果页 URL，可跳过上传步骤 |

**两条上传通道**：

1. **`file`（推荐，默认）**：`DOM.setFileInputFiles` 直接把图片塞给页面自带的 file input，
   不碰剪贴板、不受窗口焦点影响；
2. **`paste`（原始流程）**：把图片写入 Windows 剪贴板（会覆盖你剪贴板内容），聚焦页面后发 Ctrl+V。

### file 通道的标准流程（已加固，按这个跑）

```
确保入口页在 → 等上传控件出现 → 塞文件 → 等"已上传N张图片" → 点搜索 → 校验跳转 → 读结果
```

几个**不能省的等待与校验**（都是踩坑换来的）：

| 环节 | 信号 / 做法 | 不这么做会怎样 |
|---|---|---|
| 打开搜索页后 | 等 `input.image-file-reader-wrapper` 出现（不是固定 sleep） | 网络慢时控件还没渲染，塞文件失败 |
| 塞完文件后 | 等容器文案出现 **「已上传 N 张图片」** 或预览图 | 提前点搜索 → 搜了个空 |
| 点搜索前 | 再等 ~600ms 让弹层布局/动画走完，并先发一次 `mouseMoved` 悬停 | 坐标量偏 → **点空，什么也不发生** |
| 点搜索后 | **校验 URL 是否真跳转**，没跳就重新量坐标重试（最多 3 次） | 静默失败，读到的是旧结果 |
| 读结果前 | 等卡片渲染（结果页是异步的） | 读到 0 条（库里会留下空记录） |

**结果页结构要点**（踩过的坑）：

- 卡片是 `#offer-list-content [class*="searchOfferWrapper"]`，一次渲染 60 张；
- 卡片里的 `<a>` **全是旺旺聊天链接**（`title` 是提示语"点此可以直接和卖家交流…"）——
  早期版本误用这个 title 当标题，导致 60 张卡片被去重成 **1 张**；
- 商品链接不在 DOM 里（React 点击处理），但 **`data-renderkey="1_1_normal_b2b-<卖家id>_<offerId>"`**
  的最后一段就是 offerId，可拼出 `https://detail.1688.com/offer/<offerId>.html`；
- 卖家昵称在旺旺链接的 `data-nick`（URL 编码）；
- 价格文本会被渲染成 `"¥ 1 .5"`，**必须保留空格匹配再清理**，
  否则去空格会把价格和后面销量粘成 `"¥1.396700"`。

---

## 一之三、逐个联系商家（Outreach）

在结果页点每张卡片的「联系卖家」，打开该商家的旺旺会话窗口。

**联系按钮**（用户给的写法，按首张卡片写死了 `nth-child(1)`）：

```
#offer-list-content > div > div.colFeeds--cDXP1T0K > div > div:nth-child(1)
  > div.offerShopRow--GrxWF5ev > div.colRight--CxHK5xFZ > span > a
```

实际按**每张卡片内部**查找，避免 `nth-child(1)` 的硬编码：

```
[class*="offerShopRow"] a[href*="def_cbu_web_im"]   （兜底 a.ww-link）
```

**流程**：hover 卡片 → 量链接坐标 → 真实鼠标点击 → 等新标签出现
（没出现就退化为直接打开链接）→ **关掉多余聊天窗口，只留 `--keep` 个** → 落库。

**参数**：`--limit`（默认 10，可调）、`--keep`（默认 1）、`--gap`（每次间隔，默认 1200ms）、
`--image <imageId>`（限定哪一次搜索的结果页）。

**落库**：`image_contacts` 表记录「图片 ↔ 商家」，字段有
`image_id / image_file / rank / offer_id / shop_name / seller_nick / chat_uid / chat_url / status`，
后续接"图片库"时按 `image_id` 就能查出这张图联系过哪些商家。

**两个副作用要知道**：

1. 打开会话窗口会让**监控器顺手抓到该商家的会话历史**（实测 10 个商家一次性新增到联系人表）；
2. 打开会话会触发商家侧的**自动欢迎语 / 自动领券**（实测抓到"优惠券已自动领取，快去采购吧"）。

---

## 一之四、快捷短语库 + 图文发送 + 标签治理

### 全量抓历史（sweep）

```powershell
node im.mjs sweep --limit 50          # 逐个点开会话，把历史读下来入库
node im.mjs sweep --limit 20 --scroll 3   # 顺便向上滚动加载更早的消息
```

按 `messages` 表的指纹去重，**重复跑不会产生重复数据**。

### 多会话自动回复（三档模式 + 护栏）

### 比价（页面价 vs 商家回复价）

### 比价任务（Campaign）——整条链路的入口

```powershell
# ① 建任务：把「商品图片 + 询价短语」绑成一个任务
node im.mjs campaign new --image tools/qianniu/image/羽毛笔.jpg --phrase ask-custom-price2 --name "金色羽毛笔-400支"

# ② 搜图 → 联系 TOP N 商家 → 发询价（不加 --yes 只搜图并入库页面价）
node im.mjs campaign launch 1 --limit 10 --yes

# ③ 收回复 → AI 解析 → 自动追问（只处理本任务联系过的商家）
node im.mjs campaign collect 1 --draft

# ④ 出该任务的比价表（可按时间区间过滤）
node im.mjs campaign report 1 [--from 2026-09-01] [--to 2026-09-30]
node im.mjs campaign list
```

**为什么要有"任务"这一层**：它是**并行隔离的单位**。
每个任务的搜图 imageId、联系过的商家、发出的短语、收到的回复、解析出的报价
**全部带 `campaign_id`**，所以：

- 多个任务的比价流程**同时进行不会串**；
- 同时回复多个客户**不会张冠李戴**（解析时带的是本任务的商品名 + 该商品的页面价）；
- `campaign report` 只出本任务的数据，方便**按时间区间 + 商品**直接调出比价数据表。

涉及的表：`campaigns`（任务）+ 下游 5 张表都加了 `campaign_id`：
`offer_prices` / `image_contacts` / `phrase_sends` / `auto_replies` / `supplier_quotes`。

### 并发模型（重要）

### 多任务调度器（一个终端同时推进多个任务）

```powershell
node im.mjs scheduler --round 180 --slice 2 --per-task 10          # 常驻：每 3 分钟一轮
node im.mjs scheduler --once --dry                                 # 跑一轮看看（只搜图，不联系不发送）
node im.mjs scheduler --draft                                      # 真实联系+发询价，追问只填草稿
node im.mjs scheduler --send                                       # 真实发送（含追问）
```

**它是怎么"同时推进多个任务"的**（一个终端、一个进程，不抢窗口）：

```
轮1: 任务A 搜图      → 任务B 联系2家    → 任务C 解析2个会话
轮2: 任务A 联系2家   → 任务B 解析2个会话 → 任务C 联系2家
...
```

每个任务按自己的 `stage` 自动分派：

| stage | 调度器做什么 |
|---|---|
| `created` | 搜图 + 页面价入库（该任务自己的 imageId） |
| `searched` | 联系**下一批**商家（按任务跳过已联系的），凑够 `--per-task` 后转 `contacted` |
| `contacted` | 解析新回复 + 生成追问（每轮只处理 `--slice` 个会话） |

浏览器操作全程串行 + 进程锁兜底，所以**多个任务同时推进，但任何时刻只有一个在动浏览器**。

| 维度 | 现状 |
|---|---|
| **数据隔离** | ✅ 每个任务的数据带 `campaign_id`，可按任务 + 时间区间独立查询 |
| **执行并发** | ❌ **串行**：全代码库没有多线程/队列；浏览器操作一次只能一个流程 |

**为什么执行不能并行**：发送消息和读消息**都要求"当前打开的就是那个会话"**（平台限制），
而聊天窗口是独占资源——两个流程同时跑会互相抢窗口（A 发消息时 B 把窗口关掉/切走）。

**已有的保护**：`blocks/lock.mjs` 是**进程级浏览器锁**。
`campaign launch/collect`、`outreach`、`auto-reply`、`sweep`、`image-search` 都会先抢锁；
抢不到就明确报错（提示哪个 PID、哪个任务在占用），陈旧锁（进程已死）会自动清理。
实测双进程互斥有效。

**要"多任务同时推进"**，正确做法是**单浏览器 + 调度队列**（轮流推进各任务的小步骤：
A 联系 1 家 → B 解析 1 个会话 → C 联系 1 家…），而不是开多进程抢同一个浏览器。
真并行需要多浏览器实例（各自登录），有同账号多开被踢的风险。

```powershell
node im.mjs compare [--limit 30]
```

**比价的本质**（老板明确过）：不是"同图隔期搜"，而是把
**搜索页上的「页面价」** 和 **商家在聊天里报的价** 放到一起比。

商家报价有两种口径，都要处理：

| 口径 | 例子 | 怎么算 |
|---|---|---|
| `absolute` | "1.15元一支" | 直接就是可比单价 |
| `page_plus` / `page_minus` | **"页面价格+0.1"** | 页面价 + 0.1 = 可比单价 |
| `page_same` | "按页面价来就行" | 页面价就是单价 |
| `unknown` | "具体价格再谈" | 计入"信息不全"，继续追问 |

数据来源：

- `offer_prices` 表：**每次搜图自动落 60 条页面价**（imageId + offerId + 店铺 + 价格）
- `supplier_quotes` 表：AI 解析回复得到的 `price_basis` / `unit_price_final`（可比单价）
- 缺口径的历史数据，`compare` 会用原始回复**补算并回写**

输出：按可比单价升序的比价表（页面价 / 回复价原文 / 口径 / 可比单价 / 与页面价差），
末尾给出"最低/最高/价差"结论，并区分"还没给价"的供应商。

```powershell
node im.mjs auto-reply --limit 10                     # ① 演练：只解析、只拟稿，不发（默认）
node im.mjs auto-reply --limit 10 --draft             # ② 草稿：把话术填进输入框，人工点发送
node im.mjs auto-reply --limit 10 --send              # ③ 真发（会先过护栏）
node im.mjs auto-reply --limit 10 --send --min-interval 30000 --max-per-hour 20
```

**护栏**（真发/草稿都要先过，被拦会留痕 `ai_action=blocked`）：

| 护栏 | 默认 | 说明 |
|---|---|---|
| 同客户最小间隔 | 20 秒 | 防止秒回被风控 |
| 全局每小时上限 | 30 条 | 防止批量骚扰 |
| 免打扰时段 | 关 | 如 `--quiet 22-8` |
| 同消息去重 | 永久 | 同一条来消息只回一次 |
| 跳过内部同事 | 自动 | 同主体子账号不当作供应商 |

**决策**：AI 判断"不做这款产品" → 放弃该客户（`status=dropped`，不再回复）；
缺字段 → 追问；字段齐 → 不再打扰。全部留痕在 `auto_replies` 表（含 `sent` 标志）。

### 图片库对接（两种方式，任选）

```powershell
node im.mjs lib-images list      # 扫目录 → 入库，看每张图的配对短语与处理状态
node im.mjs lib-images pending   # 待处理的图片
node im.mjs lib-images bind 羽毛笔.jpg --phrase ask-custom-price2   # 给图片配短语
node im.mjs run-pending --limit 3 --yes   # 把待处理图片逐张跑完整流程
```

1. **本地文件夹（默认，推荐）**：把图片丢进 `tools/qianniu/image/` 即可，
   文件名当产品名；`lib-images list` 会自动同步进 `image_library` 表。
2. **其它来源**（HTTP/接口/共享盘）：只要提供一个 `listImages()` 返回
   `[{ path|url, fileName, size, hash }]`，其余流程（搜图→联系→发送→标记 done）完全复用。
   ——所以**不需要给我接口地址**，本地文件夹这种方式已经能跑通全链路。

### 短语库（JSON 为准，DB 存镜像）

文件 `phrase-library.json`，一条短语 = 一段文字 + 一张图（图可留空）：

```json
{ "id": "ask-custom-price", "name": "询价：定制价格",
  "text": "这个定制什么价格", "image": "tools/qianniu/image/LuminousMemories.jpg" }
```

改完跑 `node im.mjs lib sync` 同步进 `phrase_library` 表；发送记录进 `phrase_sends` 表。

### 一条命令跑完整流程

```powershell
node im.mjs run --phrase ask-custom-price --limit 5 --yes
```

流程：**选短语 → 用短语的图搜同款**（`--image` 可覆盖）**→ 联系 TOP N 商家 → 逐家发送「文字+图片」**。
不加 `--yes` 只做到"列出待联系商家"，不点不发送。

### 三条必须知道的实测结论

1. **贴图按钮是"点了就发"**：给它的 file input 塞文件后页面立刻上传并作为一条图片消息发出，
   没有预览/待发那一步。所以「文字+图片」的短语实际是**两条消息**（默认先文字、后图片，`--order` 可改）。
2. **file input 持有同名文件时再塞不触发 change**：表现为"第一次能发，之后毫无反应、连上传请求都不发"。
   必须先把 `input.value = ''` 清掉再塞（代码里已做，并在失败时补发一次 `input`/`change` 事件兜底）。
3. **窗口没加载出会话时发不出去**：聊天窗口打开了但消息区只有"暂无更多消息"（无激活会话）时，
   文字和图片都会静默失败。就绪判据必须是 `有输入区 + 有贴图 input + 有已激活会话`（代码里已收紧到 35 秒）。

### 标签治理（防止卡顿）

```powershell
node im.mjs tabs          # 看现在开了哪些页面（按 搜索页/结果页/聊天 分类）
node im.mjs tabs clean    # 每类只留一个
```

**搜索页 / 搜索结果页 / 旺旺聊天 各只保留一个**，多余的在流程开始和收尾时自动关闭
（`blocks/tabs.mjs`）。联系商家过程中聊天窗口也是"开一个关一个"，只留最新那个。

### 定时刷新聊天网页（默认每 30 分钟）

```powershell
.\tools\qianniu\start-im.ps1 -RefreshMin 30    # 每 30 分钟刷新一次（默认值）
.\tools\qianniu\start-im.ps1 -RefreshMin 0     # 关闭刷新
```

刷新做什么：清页面内存、重新同步会话列表（新商家会出现）、顺带刷新登录态。

**刷新后必须做的恢复**（已内置，否则会出问题）：

1. 页面刷新后会停在 **"AI询"** 标签页（看不到普通会话）→ 自动切回 **"全部"**；
2. 刷新会**丢掉当前打开的会话**，那种状态下**发消息会静默失败** →
   - 监听侧：把该窗口的基线标记为未登记，下一轮重新登记（不会把历史当新消息）；
   - 发送侧：`phrase-send` 会先检查是否有活跃会话，没有就自动点开第一个（都没有则明确报错）。

---

## 二、关键选择器（实测稳定）

全部在**核心帧**（`def_cbu_web_im_core`）里，代码会自动穿透 iframe 定位：

| 元素 | 选择器 | 备注 |
|---|---|---|
| 输入框 | `div.input-area .text-panel pre.edit` | `contenteditable` |
| 发送按钮 | `button.send-btn` | 空态时带 `send-btn--empty` 类 |
| 消息区 | `.message-list .rc-scrollbars-view` | 子节点即消息条目 |
| 单条消息 | 行内 `.message-item` | **`self` 类 = 我方**；`.nick` 昵称 / `.time` 时间 / `.content` 正文 |
| 会话列表项 | `.conversation-item` | **`id` 属性是账号级主键** |
| 快捷短语按钮 | `div.editor-tool img[src*="O1CN01ef7kpc20oQQ0LVt4m"]` | 按图标资源 ID 定位 |
| 快捷短语弹窗 | 文案含 `选择快捷回复短语` 的容器 | 选中后自动填入输入框并关闭 |

---

## 三、会话 id 与账号识别

会话项 `id` 的格式：

```
3159769358.1-2212374827980.1#11152@cntaobao
{一侧账号}.{版本}-{另一侧账号}.{版本}#{会话类型}@{站点}
```

**两侧顺序不固定**，要用 cookie 里的本账号 id 来分辨谁是对方：

| cookie | 含义 | 示例 |
|---|---|---|
| `unb` / `aui` | 本账号 uid | `2223107309601` |
| `c_mid`（`b2b-` 前缀） | 本账号 mid | `3159769358` |
| `__cn_logon_id__` | 本账号登录名 | `playworld152:it` |

> ⚠️ **显示名会重名**：`playworld152:it`（本账号）与 `playworld152:cqy`（同事）显示名都是 `playworld152`。
> 所以**主键必须用会话 id，绝不能退回显示名**——早期版本用显示名做主键，把两个联系人合并成了一个。
> 判定函数：`conversations.convId()` / `label()`；`isSelf` 表示"自己给自己"。

---

## 四、目录结构与区块职责

```
tools/qianniu/
├── blocks/                 功能区块（组合系统时的唯一入口 blocks/index.mjs）
│   ├── session.mjs         连接 CDP、定位核心文档、注入 __QN.* 工具、键盘/点击原语
│   ├── messages.mjs        读消息、判方向、指纹、增量比对
│   ├── conversations.mjs   读会话列表、变化检测、账号识别
│   ├── input.mjs           填入/清空/发送 + 发送结果校验
│   ├── phrases.mjs         快捷短语：开弹窗、列短语、选中填入、发送
│   ├── reply.mjs           回复引擎：规则匹配 + 风控护栏 + 留痕
│   ├── monitor.mjs         常驻监听：多窗口 + 跨会话 + 自愈 + 心跳 + 落库
│   ├── db.mjs              SQLite 落库（4+1 张表）
│   ├── logstore.mjs        事件 JSONL 落盘/读回
│   └── index.mjs           汇总导出
├── im.mjs                  CLI（薄壳，只做参数解析与打印）
├── selftest.mjs            逐区块自测（当前 9/9）
├── start-im.ps1            启动器：保证 CDP 端口 + 后台常驻监听
├── cdp-lib.mjs / cdp.mjs   通用 CDP 基础设施与调试命令
├── rules.example.json      回复规则示例（条件插槽）
├── data/im.db              SQLite 库
├── data/messages.csv       CSV 导出
└── logs/                   事件与运行日志
```

---

## 五、命令速查

```powershell
# 启动 / 停止 / 状态
.\tools\qianniu\start-im.ps1                    # 启动（默认 15 秒轮询）
.\tools\qianniu\start-im.ps1 -Stop
.\tools\qianniu\start-im.ps1 -Status
.\tools\qianniu\start-im.ps1 -Rules tools\qianniu\rules.example.json   # 带规则（默认演练）
.\tools\qianniu\start-im.ps1 -Rules rules.json -ReplyMode draft|send

# 查看
node tools\qianniu\im.mjs dashboard      # 进度看板：监听/联系人/消息/事件
node tools\qianniu\im.mjs read           # 当前会话消息（带方向）
node tools\qianniu\im.mjs convs          # 会话列表（含对方账号）
node tools\qianniu\im.mjs phrases        # 快捷短语列表

# 发送
node tools\qianniu\im.mjs draft "文本"       # 只填不发送
node tools\qianniu\im.mjs reply "文本" --yes  # 发送并落库留痕
node tools\qianniu\im.mjs reply --phrase 0 --yes
node tools\qianniu\im.mjs clear

# 数据
node tools\qianniu\im.mjs db stats|contacts|messages|export|sync
node tools\qianniu\im.mjs replies 20

# 以图搜图（比价用）
node tools\qianniu\im.mjs open-search                                   # 打开搜索页
node tools\qianniu\im.mjs run --phrase ask-custom-price --limit 5 --yes   # 一条命令跑完整流程
node tools\qianniu\im.mjs lib list | sync | add                          # 短语库
node tools\qianniu\im.mjs phrase-send ask-custom-price --yes              # 单发一条图文短语
node tools\qianniu\im.mjs tabs [clean]                                   # 标签治理（每类只留一个）
node tools\qianniu\im.mjs image-search "tools\qianniu\image\示例.png"    # 默认走上传通道
node tools\qianniu\im.mjs image-search "图片.png" --contact 10            # 搜完自动联系 TOP10 商家
node tools\qianniu\im.mjs image-search "图片.png" --method paste           # 剪贴板 + Ctrl+V（会覆盖剪贴板）
node tools\qianniu\im.mjs image-results 20                              # 读结果卡片
node tools\qianniu\im.mjs image-sellers 10                              # 只看 TOP10 商家，不点击
node tools\qianniu\im.mjs image-contact --limit 10 --keep 1              # 逐个联系 TOP10 商家
node tools\qianniu\im.mjs image-contacts 20                             # 查看"图片↔商家"记录

node tools\qianniu\im.mjs selftest        # 逐区块自测
```

---

## 六、数据库（`data/im.db`）

| 表 | 内容 | 关键约束 |
|---|---|---|
| `conversations` | 联系人档案 | `conv_key` 主键＝会话 id |
| `messages` | 消息明细 | `UNIQUE(conv_key, fingerprint)` 去重；`msg_epoch` 由界面时间换算 |
| `events` | 原始事件流水 | 与 `logs/im-events.jsonl` 双写 |
| `heartbeats` | 监听心跳 | 判断采集是否中断 |
| `replies` | 回复留痕 | 含被护栏拦截的记录（`status`/`detail`） |
| `image_searches` | 以图搜图记录 | 本地图片 → imageId → 结果页，可重放 |
| `image_contacts` | **图片 ↔ 商家** | 每次搜图联系了哪些商家（rank/店铺/offerId/会话链接） |
| `phrase_library` | 快捷短语库镜像 | 从 `phrase-library.json` 同步 |
| `phrase_sends` | **短语发送留痕** | 发给了谁、图/文各自成功没有 |

---

## 七、踩过的坑（都已修，改代码前先看这里）

1. **注入字符串里的正则要写两遍反斜杠**：`HELPERS` 是模板字符串，`\d` 会退化成字面量 `d`，
   导致 cookie 解析永远失败、认不出本账号 id。
2. **`fetch` 的 keep-alive 会让监听永久卡死**：Chrome 重启后池里的半死 socket 被复用，
   请求永远等不到响应且无超时 → 监听静默 4 天（CPU 归零、0 连接）。
   已改用 `node:http` + `agent:false` + 显式超时；所有 await 都有超时兜底。
3. **30 秒超时定时器不清除**会让进程退出被拖 30 秒；`runMonitor` 不关 WebSocket 会让事件循环挂住。
4. **相对时间会漂移**（"6分钟前"→"10分钟前"），会话指纹绝不能包含它，否则每轮误报新消息。
5. **同名会话**（置顶区+最近区各一条）要用「id → 指纹集合」，用单值会互相覆盖导致刷屏。
6. **切换会话要重置基线**，否则新会话的历史消息会被整段当成新消息。
7. **`document.execCommand('selectAll'/'delete')` 对这个编辑器无效**：清空必须用真实
   Ctrl+A + Backspace；填入前必须先清空，靠 DOM Range 全选会导致"追加"而非"覆盖"。
8. **DevTools 窗口的标题含被调试地址**，会干扰 target 匹配；已排除 `devtools://` 并优先按 URL 匹配。
9. **发送没有 HTTP 接口**：发送走原生 IM 层，Network 面板抓不到。可行通道只有
   输入框直发（可信输入事件）与快捷短语两条。

---

## 八、风控与合规

- 自动回复默认 **`dryRun=true`（演练，不发送）**；`draftOnly` 只填草稿等人工点发送；
  真发必须显式 `-ReplyMode send`。
- 内置限速：同会话最小间隔 8s、全局 30 条/时、单会话 10 条/时、同消息去重 1h、免打扰时段。
- 建议保持"机器起草 + 人工放行"，尤其议价场景；异常节奏容易触发平台风控。

---

## 九、已知边界

- **完整历史只有"当前打开的会话"能读**；`sweep` 可以逐个点开把列表里的会话历史全部抓下来。
- ⚠️ **网页版的会话列表只保留最近约 9–11 个会话**（实测），
  「联系人」标签是空的（未分组好友 0），所以**平台没显示出来的更早会话抓不到**——
  这是平台限制，不是代码问题。`sweep` 只能覆盖"列表里出现过的会话"。
- **自动回复只对当前打开的会话生效**（消息级事件天然满足）；其它会话的动静只记 `conv-update`，
  不会误发到别的会话。
- 该 Chrome 调试实例必须保持开启并登录；重启电脑后重新跑一次 `start-im.ps1`。
