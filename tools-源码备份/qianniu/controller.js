/* =====================================================================
 * 1688卖家工作台（千牛 / AliWorkbench，CEF 内核）控制器骨架
 *
 * 能力：① 监听新消息（事件驱动，零间隙，不漏消息）
 *       ② 定时兜底轮询（防止 DOM 重渲染导致漏掉）
 *       ③ 记录「响应时长 / 消息间隙」，对应界面上的 3min响应率
 *       ④ 安全发送（默认 dry-run 演练，不会真的发出去）
 *
 * 用法：
 *   1. 先跑 probe.js，把 sel.* 四个选择器填上（见下方 TODO）
 *   2. 在工作台 Console 粘贴本文件全文 → 回车
 *   3. QN.start()  启动监听（dry-run 模式只打印不发送）
 *   4. 确认逻辑无误后 QN.cfg.dryRun = false 再发送
 *   5. QN.stop() 停止；QN.stats() 看响应时长统计
 * ===================================================================== */
window.QN = (function () {
  'use strict';

  var cfg = {
    dryRun: true,            // ★ 安全阀：true = 只打印，不发送
    pollMs: 4000,            // 兜底轮询间隔（ms）
    minReplyGapMs: 15000,    // 同一会话两次自动发送的最小间隔（ms）
    maxSendsPerHour: 30,     // 每小时最多自动发送条数（防风控）
    debug: true,
    sel: {
      // TODO: 用 probe.js 的输出填写，留空的项会自动降级处理
      convTitle: '',  // 顶部当前对话的对方昵称
      convList:  '',  // 左侧会话列表容器
      msgList:   '',  // 中间消息区容器
      msgItem:   '',  // 单条消息节点
      input:     '',  // 输入框
      sendBtn:   ''   // 发送按钮
    },
    // 自定义「这条消息是不是我发的」判断；默认用类名/位置启发式
    isMine: null
  };

  var state = {
    running: false,
    timer: null,
    observer: null,
    seen: {},          // 已见消息指纹
    primed: false,     // 首次扫描只登记、不触发回调
    sendLog: [],       // 发送时间戳，用于限速
    stats: {},         // per 会话：消息间隔与响应时长
    handlers: []       // 新消息回调
  };

  /* ---------- 基础工具 ---------- */
  function log() {
    if (!cfg.debug) return;
    var a = ['%c[QN]', 'color:#7c3aed;font-weight:bold'].concat(Array.prototype.slice.call(arguments));
    console.log.apply(console, a);
  }
  function warn() {
    var a = ['%c[QN]', 'color:#c00;font-weight:bold'].concat(Array.prototype.slice.call(arguments));
    console.warn.apply(console, a);
  }

  /* 所有可读文档（含同源 iframe），千牛的模块常驻 iframe */
  function docs() {
    var list = [document];
    Array.prototype.forEach.call(document.querySelectorAll('iframe'), function (f) {
      try { if (f.contentDocument && f.contentDocument.body) list.push(f.contentDocument); } catch (e) { /* 跨域忽略 */ }
    });
    return list;
  }

  function find(sel, rootOnly) {
    if (!sel) return null;
    var ds = rootOnly ? [document] : docs();
    for (var i = 0; i < ds.length; i++) {
      var el = ds[i].querySelector(sel);
      if (el) return el;
    }
    return null;
  }

  function findAll(sel) {
    if (!sel) return [];
    var out = [];
    docs().forEach(function (d) {
      try { out.push.apply(out, Array.prototype.slice.call(d.querySelectorAll(sel))); } catch (e) { /* ignore */ }
    });
    return out;
  }

  function txt(el) { return (el ? (el.innerText || el.textContent || '') : '').replace(/\s+/g, ' ').trim(); }

  /* ---------- 消息解析 ---------- */
  function currentConversation() {
    var t = find(cfg.sel.convTitle);
    var name = txt(t) || document.title || 'unknown';
    return name.slice(0, 40);
  }

  /* 默认「是否我方发送」的判断：类名线索 + 气泡水平位置 */
  function defaultIsMine(el) {
    var box = el;
    for (var i = 0; i < 4 && box; i++) {
      var cls = (typeof box.className === 'string' ? box.className : '') + ' ' +
                (box.getAttribute && (box.getAttribute('data-spm') || '') || '');
      if (/self|mine|right|fromme|my-?msg|send(er)?/i.test(cls)) return true;
      if (/other|receive|left|fromother|guest|buyer/i.test(cls)) return false;
      box = box.parentElement;
    }
    var list = find(cfg.sel.msgList);
    if (list) {
      var lr = list.getBoundingClientRect();
      var er = el.getBoundingClientRect();
      if (lr.width > 0) return (er.left + er.width / 2) > (lr.left + lr.width / 2);
    }
    return false;
  }

  function parseMessages() {
    var items = findAll(cfg.sel.msgItem);
    return items.map(function (el, idx) {
      var mine = cfg.isMine ? !!cfg.isMine(el) : defaultIsMine(el);
      var body = txt(el);
      return {
        idx: idx,
        mine: mine,
        text: body.slice(0, 200),
        /* 指纹：内容 + 我/对方 + 顺序，用于去重 */
        key: (mine ? 'O' : 'I') + '|' + body.slice(0, 120) + '|' + idx,
        el: el
      };
    });
  }

  /* ---------- 间隔 / 响应时长统计 ---------- */
  function trackGaps(msgs) {
    var conv = currentConversation();
    var s = state.stats[conv] || (state.stats[conv] = {
      inbound: 0, outbound: 0,
      lastInboundAt: null, lastOutboundAt: null,
      pendingReplyFrom: null,       // 对方最近一条待回复的时间
      responses: [],                // 响应时长样本（ms）
      maxIdleGapMs: 0               // 对方连续消息之间的最大间隙
    });

    msgs.forEach(function (m) {
      if (state.seen[m.key]) return;
      state.seen[m.key] = Date.now();
      var now = Date.now();

      if (m.mine) {
        s.outbound++;
        s.lastOutboundAt = now;
        if (s.pendingReplyFrom) {
          s.responses.push(now - s.pendingReplyFrom);
          s.pendingReplyFrom = null;
        }
      } else {
        // 对方连发多条之间的「间隙」
        if (s.lastInboundAt) {
          var gap = now - s.lastInboundAt;
          if (gap > s.maxIdleGapMs) s.maxIdleGapMs = gap;
        }
        s.inbound++;
        s.lastInboundAt = now;
        if (!s.pendingReplyFrom) s.pendingReplyFrom = now;

        /* 首次预热不触发回调，避免历史消息被当成新消息 */
        if (state.primed) {
          state.handlers.forEach(function (h) {
            try { h({ conv: conv, text: m.text, at: now, el: m.el }); } catch (e) { warn('回调异常:', e.message); }
          });
        }
      }
    });
  }

  function scan() {
    var msgs = parseMessages();
    if (!msgs.length) return [];
    trackGaps(msgs);
    state.primed = true;
    return msgs;
  }

  /* ---------- 发送 ---------- */
  function canSend() {
    var cutoff = Date.now() - 3600 * 1000;
    state.sendLog = state.sendLog.filter(function (t) { return t > cutoff; });
    if (state.sendLog.length >= cfg.maxSendsPerHour) { warn('已达每小时发送上限，跳过'); return false; }
    var last = state.sendLog[state.sendLog.length - 1] || 0;
    if (Date.now() - last < cfg.minReplyGapMs) { warn('距上次发送过近，跳过'); return false; }
    return true;
  }

  function send(text) {
    if (!text) return false;
    var input = find(cfg.sel.input);
    if (!input) { warn('找不到输入框，请先跑 probe.js 填 sel.input'); return false; }

    if (cfg.dryRun) {
      log('【演练模式】本来要发送:', JSON.stringify(text));
      return true;
    }
    if (!canSend()) return false;

    input.focus();
    if (input.isContentEditable) {
      // 富文本输入框：用 insertText 触发框架的 input 事件
      var rg = document.createRange();
      rg.selectNodeContents(input);
      var selObj = window.getSelection();
      selObj.removeAllRanges(); selObj.addRange(rg);
      document.execCommand('insertText', false, text);
    } else {
      var setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value') ||
                   Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, 'value');
      setter.set.call(input, text);
      input.dispatchEvent(new Event('input', { bubbles: true }));
    }
    input.dispatchEvent(new Event('change', { bubbles: true }));

    var btn = find(cfg.sel.sendBtn);
    if (btn) {
      btn.click();
    } else {
      // 兜底：回车发送
      ['keydown', 'keypress', 'keyup'].forEach(function (type) {
        input.dispatchEvent(new KeyboardEvent(type, { key: 'Enter', code: 'Enter', keyCode: 13, which: 13, bubbles: true }));
      });
    }
    state.sendLog.push(Date.now());
    log('已发送:', JSON.stringify(text));
    return true;
  }

  /* ---------- 启动 / 停止 ---------- */
  function attachObserver() {
    var target = find(cfg.sel.msgList) || document.body;
    if (!target) return;
    if (state.observer) state.observer.disconnect();
    var pending = null;
    state.observer = new MutationObserver(function () {
      // 抖动合并：DOM 一次渲染往往触发几十次 mutation
      if (pending) return;
      pending = setTimeout(function () { pending = null; scan(); }, 300);
    });
    state.observer.observe(target, { childList: true, subtree: true, characterData: true });
    log('事件监听已挂载于:', target.tagName, target.className || '(无class)');
  }

  function start(handler) {
    if (state.running) { warn('已在运行'); return; }
    state.running = true;
    state.primed = false;
    if (handler) state.handlers.push(handler);
    scan();                 // 预热：登记历史消息，不触发回调
    state.primed = true;
    attachObserver();
    // 兜底轮询：应对 DOM 整块重渲染 / 虚拟滚动导致 observer 丢事件
    state.timer = setInterval(function () {
      scan();
      if (cfg.sel.convList && !find(cfg.sel.convList)) { /* 视图切换后可在此重新挂载 */ }
    }, cfg.pollMs);
    log('已启动。dryRun =', cfg.dryRun, '| 轮询', cfg.pollMs + 'ms');
  }

  function stop() {
    state.running = false;
    if (state.timer) clearInterval(state.timer);
    if (state.observer) state.observer.disconnect();
    state.timer = null;
    state.observer = null;
    log('已停止');
  }

  function stats() {
    var out = {};
    Object.keys(state.stats).forEach(function (k) {
      var s = state.stats[k];
      var avg = s.responses.length
        ? Math.round(s.responses.reduce(function (a, b) { return a + b; }, 0) / s.responses.length / 1000)
        : null;
      out[k] = {
        对方消息数: s.inbound,
        我方消息数: s.outbound,
        平均响应秒: avg,
        对方最大间隙秒: Math.round(s.maxIdleGapMs / 1000),
        超3分钟未回: s.pendingReplyFrom ? Math.round((Date.now() - s.pendingReplyFrom) / 1000) : 0
      };
    });
    console.table(out);
    return out;
  }

  function on(handler) { state.handlers.push(handler); return handler; }

  return {
    cfg: cfg,
    start: start,
    stop: stop,
    send: send,
    scan: scan,
    stats: stats,
    on: on,
    state: state,
    _find: find
  };
})();

/* ===================== 使用示例 =====================
 *
 * // 1) 启动（演练模式，只打印不发送）
 * QN.start(function (msg) {
 *   console.log('收到新消息：', msg.conv, '->', msg.text);
 * });
 *
 * // 2) 接入你的回复逻辑（示例：关键词自动应答）
 * QN.on(function (msg) {
 *   if (/价格|报价/.test(msg.text)) QN.send('亲，这款可以走批价，您要多少件？');
 * });
 *
 * // 3) 看响应时长 / 间隙统计
 * QN.stats();
 *
 * // 4) 确认无误后真正发送
 * QN.cfg.dryRun = false;
 *
 * // 5) 停止
 * QN.stop();
 * ================================================= */
