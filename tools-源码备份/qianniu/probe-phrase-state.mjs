/* 诊断：聊天窗口没开会话时，快捷短语区块为什么没给出清晰错误
   node tools/qianniu/probe-phrase-state.mjs
*/
import { session, phrases } from './blocks/index.mjs';

const st = await session.withSession((s) => session.evaluate(s, `(() => {
  const d = __QN.core();
  return {
    coreFound: !!d,
    hasInput: !!__QN.input(),
    activeConv: __QN.activeConvId(),
    convCount: __QN.convs().length,
    toolbarFound: !!(d && d.querySelector('div.editor-tool')),
    btnBox: __QN.boxOf(__QN.phraseBtnSel),
    dialogOpen: !!__QN.phraseDialog(),
    itemCount: __QN.phraseItems().length
  };
})()`));
console.log('DOM 状态:', JSON.stringify(st, null, 2));

try {
  const r = await phrases.list();
  console.log('phrases.list() 返回:', JSON.stringify(r));
} catch (e) {
  console.log('phrases.list() 抛错:', e.message);
}
