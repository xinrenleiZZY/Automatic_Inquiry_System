import dayjs from 'dayjs';

export const fmtTime = (v?: number | string | null, withSecond = true): string => {
  if (v === null || v === undefined || v === '') return '-';
  let n = typeof v === 'string' ? Number(v) : v;
  if (!Number.isFinite(n)) return String(v);
  if (n < 1e11) n = n * 1000;
  return dayjs(n).format(withSecond ? 'YYYY-MM-DD HH:mm:ss' : 'YYYY-MM-DD HH:mm');
};

export const fmtMoney = (v?: number | null, digits = 4): string =>
  v === null || v === undefined ? '-' : Number(v).toFixed(digits).replace(/0+$/, '').replace(/\.$/, '');

export const basisLabel = (b?: string | null): string =>
  ({ absolute: '直接报价', page_plus: '页面价加价', page_minus: '页面价减价', page_same: '与页面价相同' } as Record<string, string>)[
    String(b || '')
  ] || (b || '-');

export const statusLabel = (s?: string | null): string =>
  ({ running: '进行中', paused: '已暂停', done: '已完成', archived: '已归档', draft: '草稿', stopped: '已停止' } as Record<
    string,
    string
  >)[String(s || '')] || (s || '-');

export const stageLabel = (s?: string | null): string =>
  ({ searched: '已搜图', contacted: '已联系', collected: '已采集', pending: '待开始' } as Record<string, string>)[
    String(s || '')
  ] || (s || '待开始');

export const verdictColor = (v?: string): string =>
  v === '低于页面价' ? 'green'
  : v === '高于页面价' ? 'red'
  : v === '与页面价持平' ? 'blue'
  : v === '需人工联系' ? 'orange'
  : (v === '不做此款' || v === '信息不全') ? 'default'
  : 'default';

export const bytes = (n?: number): string => {
  if (!n) return '-';
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / 1024 / 1024).toFixed(2)} MB`;
};
