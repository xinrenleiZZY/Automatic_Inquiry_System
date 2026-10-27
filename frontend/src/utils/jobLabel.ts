/* 作业类型 → 人话。
 * 新增队列处理器时，这里补一行；后端 backend/app/alerts.py 里的 JOB_CN 也要补一行
 * （那边给飞书卡片用，两边保持一致）。 */
export const JOB_CN: Record<string, string> = {
  'campaign.launch': '任务·发起询价',
  'campaign.collect': '任务·采集回复并追问',
  'campaign.advance': '任务·推进阶段',
  'campaign.resend': '任务·补发询价',
  'campaign.nudge': '任务·催问',
  'campaign.autocollect': '全自动采集（按客户独立计时）',
  'campaign.fullauto': '全自动比价（一条龙）',
  'campaign.fullauto.flow': '全自动比价（分步流程）',
  'flow.step': '全自动·单步',
  'scheduler.once': '多任务调度器·一轮',
  'image.search': '以图搜图',
  'outreach.contact': '联系商家',
  'send.text': '发送文字',
  'send.phrase': '发送图文短语',
  'send.image': '发送图片',
  'autoreply.run': '自动回复·一轮',
  'page.refresh': '刷新页面',
  'monitor.once': '监控·一轮',
  'tabs.enforce': '标签治理',
  'sweep.run': '抓取会话/消息'
};

export const jobCN = (t?: string) => JOB_CN[String(t || '')] || String(t || '-');
