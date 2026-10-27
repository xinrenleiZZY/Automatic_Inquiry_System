/* =====================================================================
 * [工具脚本] 列出各功能区块的对外接口 —— 保证 INTEGRATION.md 与代码一致
 *
 *   node tools/qianniu/list-api.mjs            # 人类可读
 *   node tools/qianniu/list-api.mjs --json     # 机器可读（生成 MANIFEST 用）
 * ===================================================================== */

import * as blocks from './blocks/index.mjs';

const out = {};
for (const [name, mod] of Object.entries(blocks)) {
  const fns = [];
  const classes = [];
  const consts = [];
  for (const [k, v] of Object.entries(mod)) {
    if (typeof v === 'function') {
      /* class 的 typeof 也是 function，用首字母大写粗略区分 */
      if (/^[A-Z]/.test(k)) classes.push(k);
      else fns.push(k);
    } else if (typeof v === 'string' || typeof v === 'number') {
      consts.push(k);
    }
  }
  out[name] = {
    函数: fns.sort(),
    类: classes.sort(),
    常量: consts.sort()
  };
}

if (process.argv.includes('--json')) {
  console.log(JSON.stringify(out, null, 2));
} else {
  for (const [name, api] of Object.entries(out)) {
    const n = api.函数.length + api.类.length + api.常量.length;
    console.log(`\n■ ${name}  （对外 ${n} 项）`);
    if (api.类.length) console.log('   类  : ' + api.类.join(', '));
    if (api.函数.length) console.log('   函数: ' + api.函数.join(', '));
    if (api.常量.length) console.log('   常量: ' + api.常量.join(', '));
  }
  console.log('\n（系统融合时只 import blocks/index.mjs 这一个入口）');
}
