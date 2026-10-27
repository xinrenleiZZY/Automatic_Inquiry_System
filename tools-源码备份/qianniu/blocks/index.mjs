/* =====================================================================
 * 功能区块总入口 —— 组合系统时从这里 import
 * [融合入口 · v0.1 · 系统只依赖这一个文件，不要直接依赖 im.mjs]
 *
 *   import { messages, conversations, input, phrases, monitor, logstore } from './blocks/index.mjs';
 *
 *   const msgs = await messages.readMessages();
 *   const convs = await conversations.readConversations();
 *   await input.sendText('你好');
 *   await phrases.use(0, { send: true });
 *   await monitor.runMonitor({ interval: 15000 });
 * ===================================================================== */

import * as session from './session.mjs';
import * as messages from './messages.mjs';
import * as conversations from './conversations.mjs';
import * as input from './input.mjs';
import * as phrases from './phrases.mjs';
import * as monitor from './monitor.mjs';
import * as logstore from './logstore.mjs';
import * as db from './db.mjs';
import * as reply from './reply.mjs';
import * as imageSearch from './image-search.mjs';
import * as outreach from './outreach.mjs';
import * as library from './library.mjs';
import * as phraseSend from './phrase-send.mjs';
import * as tabs from './tabs.mjs';
import * as ai from './ai.mjs';
import * as autoReply from './auto-reply.mjs';
import * as imageLibrary from './image-library.mjs';
import * as sweep from './sweep.mjs';
import * as campaign from './campaign.mjs';
import * as scheduler from './scheduler.mjs';

export { session, messages, conversations, input, phrases, monitor, logstore, db, reply, imageSearch, outreach, library, phraseSend, tabs, ai, autoReply, imageLibrary, sweep, campaign, scheduler };
