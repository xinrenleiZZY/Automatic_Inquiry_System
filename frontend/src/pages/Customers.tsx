import { useEffect, useMemo, useState, type CSSProperties } from 'react';
import { Alert, Button, Card, DatePicker, Descriptions, Drawer, Empty, Image, Input, Select, Space, Table, Tag, Tooltip, Typography, message } from 'antd';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import dayjs, { type Dayjs } from 'dayjs';

import { detailOf, get, post } from '../api/client';
import type { Campaign, ChatMessage, Customer } from '../api/types';
import { fmtMoney, fmtTime } from '../utils/format';
import { useJobRunner } from '../components/JobRunner';

interface ChatResp {
  conversation: Record<string, unknown> | null;
  messages: ChatMessage[];
  quotes: Array<Record<string, unknown>>;
  phrase_sends: Array<Record<string, unknown>>;
  auto_replies: Array<Record<string, unknown>>;
  flag?: { list_type?: string; note?: string } | null;
}

const LIST_TAG: Record<string, { text: string; color: string }> = {
  whitelist: { text: '白名单', color: 'green' },
  blacklist: { text: '黑名单', color: 'red' },
  dropped: { text: '已放弃', color: 'default' }
};

const RESULT_TAG: Record<string, { text: string; color: string }> = {
  waiting: { text: '跟进中', color: 'blue' },
  complete: { text: '信息已集齐', color: 'green' },
  dropped: { text: '不做此款', color: 'red' },
  needs_human: { text: '需人工联系', color: 'orange' },
  give_up: { text: '信息不全', color: 'default' }
};

/* 长文本一律单行截断：
   列的宽度必须显式给（否则 antd 会退化成 table-layout:auto，
   可换行的列会被压到极限宽度，客户名会逐字竖排 —— 实测踩过）。 */
const ELLIPSIS: CSSProperties = {
  overflow: 'hidden',
  textOverflow: 'ellipsis',
  whiteSpace: 'nowrap',
  maxWidth: '100%'
};

export default function Customers() {
  const qc = useQueryClient();
  const [keyword, setKeyword] = useState('');
  const [keywordInput, setKeywordInput] = useState('');
  const [campaignId, setCampaignId] = useState<number | undefined>(undefined);
  /* 时间筛选：按"该会话最后一条消息的时间"（台账里「最近消息」那列）过滤 */
  const [range, setRange] = useState<[Dayjs | null, Dayjs | null] | null>(null);
  const [active, setActive] = useState<Customer | null>(null);
  const [resultFilter, setResultFilter] = useState<string | undefined>(undefined);

  const fromMs = range?.[0] ? range[0].startOf('day').valueOf() : undefined;
  const toMs = range?.[1] ? range[1].endOf('day').valueOf() : undefined;

  const list = useQuery({
    queryKey: ['customers', keyword, campaignId, fromMs, toMs],
    queryFn: () =>
      get<{ items: Customer[]; total: number }>('/api/data/customers', {
        keyword: keyword || undefined,
        campaign_id: campaignId,
        from: fromMs,
        to: toMs,
        limit: 500
      }),
    refetchInterval: 15000
  });

  /* 任务下拉：选哪个任务，就只看该任务联系过的客户 */
  const campaigns = useQuery({
    queryKey: ['campaigns'],
    queryFn: () => get<{ items: Campaign[] }>('/api/campaigns', { include_archived: true })
  });
  const campaignName = useMemo(
    () => campaigns.data?.items.find((c) => c.id === campaignId)?.name,
    [campaigns.data, campaignId]
  );
  const visibleCustomers = useMemo(() => {
    const rows = list.data?.items || [];
    return resultFilter
      ? rows.filter((row) => row.result_status === resultFilter)
      : rows;
  }, [list.data, resultFilter]);
  /* 名单的适用范围文案：0 = 全部任务；>0 = 该任务专属 */
  const scopeLabel = (id?: number | null) =>
    !id ? '全部任务' : (campaigns.data?.items.find((c) => c.id === id)?.name || `任务 ${id}`);

  const chat = useQuery({
    queryKey: ['chat', active?.conv_key, campaignId],
    queryFn: () =>
      get<ChatResp>('/api/data/chat', {
        conv_key: active!.conv_key,
        limit: 500,
        campaign_id: campaignId ?? 0
      }),
    enabled: !!active
  });

  /* 抓全历史：网页版旺旺只在打开会话时按页加载消息，这里点一下就把该会话
     逐页翻上去抓全（走队列，会短暂占用聊天窗口，和别的任务不会打架）。 */
  const runner = useJobRunner(() => {
    void chat.refetch();
  });
  const [sweeping, setSweeping] = useState(false);
  const sweepHistory = async () => {
    if (!active) return;
    setSweeping(true);
    try {
      const { job } = await post<{ job: { id: string } }>(
        `/api/flows/sweep?conv_key=${encodeURIComponent(active.conv_key)}&scroll=5&limit=1`,
        {}
      );
      runner.start(job.id);
    } catch (e) {
      message.error(detailOf(e));
    } finally {
      setSweeping(false);
    }
  };

  useEffect(() => {
    const h = () => void qc.invalidateQueries();
    window.addEventListener('ais:refresh', h);
    return () => window.removeEventListener('ais:refresh', h);
  }, [qc]);

  const columns = useMemo(
    () => [
      {
        title: '客户',
        dataIndex: 'name',
        width: 260,
        render: (v: string, r: Customer) => (
          <div style={{ minWidth: 0 }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
              <Typography.Text strong style={ELLIPSIS} title={v}>
                {v}
              </Typography.Text>
              {r.list_type ? (
                <Tooltip title={`名单适用范围：${scopeLabel(r.flag_scope)}`}>
                  <Tag
                    color={LIST_TAG[r.list_type]?.color}
                    style={{ marginInlineEnd: 0, flex: 'none' }}
                  >
                    {LIST_TAG[r.list_type]?.text}
                  </Tag>
                </Tooltip>
              ) : null}
              {r.is_self ? (
                <Tag style={{ marginInlineEnd: 0, flex: 'none' }}>内部同事</Tag>
              ) : null}
            </div>
            <div style={{ fontSize: 11, color: '#98a4b8', ...ELLIPSIS }} title={r.conv_key}>
              {r.conv_key}
            </div>
          </div>
        )
      },
      {
        title: '往来',
        width: 150,
        render: (_: unknown, r: Customer) => (
          <Space size={6}>
            <Tag color="blue">对方 {r.in_count ?? 0}</Tag>
            <Tag color="geekblue">我方 {r.out_count ?? 0}</Tag>
          </Space>
        )
      },
      {
        title: '跟进结果',
        width: 280,
        render: (_: unknown, r: Customer) => {
          const info = RESULT_TAG[String(r.result_status || 'waiting')] || RESULT_TAG.waiting;
          return (
            <div style={{ width: '100%', minWidth: 0, overflow: 'hidden' }}>
              <Tag color={info.color} style={{ marginInlineEnd: 0, marginBottom: 4 }}>
                {r.result_label || info.text}
              </Tag>
              <Typography.Text
                type="secondary"
                style={{
                  display: 'block',
                  width: '100%',
                  maxWidth: '100%',
                  overflow: 'hidden',
                  textOverflow: 'ellipsis',
                  whiteSpace: 'nowrap',
                  fontSize: 11.5,
                  lineHeight: '16px'
                }}
                title={r.result_detail || r.result_reason || ''}
              >
                {r.result_reason || '暂无结果说明'}
              </Typography.Text>
            </div>
          );
        }
      },
      {
        title: '报价',
        width: 170,
        render: (_: unknown, r: Customer) => (
          <Space size={6}>
            <Tag>{r.quote_count ?? 0} 条</Tag>
            {r.best_price != null ? <Tag color="green">最低 {fmtMoney(r.best_price)}</Tag> : null}
          </Space>
        )
      },
      {
        title: '关联图片 / 短语',
        width: 330,
        render: (_: unknown, r: Customer) => (
          <div style={{ minWidth: 0 }}>
            <div style={{ fontSize: 12, ...ELLIPSIS }} title={r.image_ids || '-'}>
              图片：{r.image_ids || '-'}
            </div>
            <div style={{ fontSize: 12, color: '#8b98ad', ...ELLIPSIS }} title={r.phrase_ids || '-'}>
              短语：{r.phrase_ids || '-'}
            </div>
          </div>
        )
      },
      {
        title: '最近消息',
        dataIndex: 'last_text',
        width: 300,
        render: (v: string, r: Customer) => (
          <div style={{ minWidth: 0 }}>
            <div style={{ fontSize: 12.5, ...ELLIPSIS }} title={v}>
              {v || '-'}
            </div>
            <div style={{ fontSize: 11, color: '#a8b3c6' }}>{fmtTime(r.last_at)}</div>
          </div>
        )
      }
    ],
    [campaigns.data]
  );

  return (
    <>
      <Card
        title={`客户台账（${visibleCustomers.length}/${list.data?.total ?? 0}）${campaignName ? ` · ${campaignName}` : ''}`}
        extra={
          <Space wrap>
            <Select
              allowClear
              placeholder="按任务筛选"
              style={{ width: 210 }}
              loading={campaigns.isLoading}
              value={campaignId}
              onChange={(v) => setCampaignId(v as number | undefined)}
              options={(campaigns.data?.items || []).map((c) => ({
                value: c.id,
                label: `${c.name}（#${c.id}）`
              }))}
            />
            <Select
              allowClear
              placeholder="按跟进结果筛选"
              style={{ width: 170 }}
              value={resultFilter}
              onChange={(v) => setResultFilter(v as string | undefined)}
              options={Object.entries(RESULT_TAG).map(([value, item]) => ({
                value,
                label: item.text
              }))}
            />
            <Tooltip title="按「最近消息」的时间筛选（= 该会话最后一条消息的时间）">
              <DatePicker.RangePicker
                value={range}
                onChange={(v) => setRange(v as [Dayjs | null, Dayjs | null] | null)}
                placeholder={['最近消息起', '止']}
                style={{ width: 246 }}
              />
            </Tooltip>
            <Input.Search
              value={keywordInput}
              placeholder="搜索客户名 / 会话号"
              allowClear
              style={{ width: 210 }}
              onChange={(e) => {
                setKeywordInput(e.target.value);
                if (!e.target.value) setKeyword('');
              }}
              onSearch={setKeyword}
            />
            {keyword || campaignId !== undefined || range || resultFilter ? (
              <Button
                onClick={() => {
                  setKeyword('');
                  setKeywordInput('');
                  setCampaignId(undefined);
                  setRange(null);
                  setResultFilter(undefined);
                }}
              >
                重置
              </Button>
            ) : null}
          </Space>
        }
        styles={{ body: { padding: 12 } }}
      >
        <Table
          rowKey="conv_key"
          size="middle"
          loading={list.isLoading}
          dataSource={visibleCustomers}
          columns={columns}
          scroll={{ x: 1490 }}
          tableLayout="fixed"
          pagination={{ pageSize: 15, showSizeChanger: true, showTotal: (t) => `共 ${t} 个客户` }}
          onRow={(r) => ({ onClick: () => setActive(r), style: { cursor: 'pointer' } })}
        />
      </Card>

      <Drawer
        open={!!active}
        width={720}
        title={active ? `${active.name}` : ''}
        onClose={() => setActive(null)}
        styles={{ body: { background: '#fbfcfe' } }}
      >
        {active ? (
          <Space direction="vertical" size={14} style={{ width: '100%' }}>
            <Descriptions size="small" column={2} bordered>
              <Descriptions.Item label="会话号" span={2}>
                <Typography.Text copyable style={{ fontSize: 12 }}>
                  {active.conv_key}
                </Typography.Text>
              </Descriptions.Item>
              <Descriptions.Item label="消息数">{active.msg_count ?? 0}</Descriptions.Item>
              <Descriptions.Item label="报价条数">{active.quote_count ?? 0}</Descriptions.Item>
              <Descriptions.Item label="最低可比单价">{active.best_price != null ? fmtMoney(active.best_price) : '-'}</Descriptions.Item>
              <Descriptions.Item label="名单">
                {(() => {
                  /* 名单带任务维度：优先用当前任务下"生效的"那份（切任务时抽屉里的标签跟着变） */
                  const f = (chat.data?.flag || (active.list_type
                    ? { list_type: active.list_type, campaign_id: active.flag_scope }
                    : null)) as { list_type?: string; campaign_id?: number } | null;
                  if (!f?.list_type) return '正常';
                  return (
                    <Space size={4}>
                      <Tag color={LIST_TAG[f.list_type]?.color}>{LIST_TAG[f.list_type]?.text}</Tag>
                      <Typography.Text style={{ fontSize: 11, color: '#8b98ad' }}>
                        {scopeLabel(f.campaign_id)}
                      </Typography.Text>
                    </Space>
                  );
                })()}
              </Descriptions.Item>
            </Descriptions>

            {(() => {
              const info = RESULT_TAG[String(active.result_status || 'waiting')] || RESULT_TAG.waiting;
              const alertType = active.result_status === 'dropped'
                ? 'error'
                : active.result_status === 'complete'
                  ? 'success'
                  : active.result_status === 'needs_human'
                    ? 'warning'
                    : 'info';
              return (
                <Alert
                  type={alertType}
                  showIcon
                  message={active.result_label || info.text}
                  description={active.result_detail || active.result_reason || '暂无结果说明'}
                />
              );
            })()}

            {chat.isLoading ? (
              <Empty description="加载中…" image={Empty.PRESENTED_IMAGE_SIMPLE} />
            ) : (
              <>
                <div>
                  <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 8 }}>
                    <Typography.Text strong>往来记录（{chat.data?.messages.length ?? 0}）</Typography.Text>
                    <Tooltip title="网页版旺旺只在打开会话时才按页加载消息。点这里会把该会话真的点开、向上翻几页，把更早的图片/文字补抓进库（会短暂占用聊天窗口）">
                      <Button size="small" loading={sweeping} onClick={() => void sweepHistory()}>
                        抓全历史
                      </Button>
                    </Tooltip>
                  </div>
                  <div className="ais-chat" style={{ marginTop: 8 }}>
                    {(chat.data?.messages || []).length ? (
                      chat.data!.messages.map((m) => (
                        <div key={m.id} className={`ais-chat-row ${m.direction === 'out' ? 'out' : ''}`}>
                          <div>
                            <div className="ais-chat-bubble">
                              {m.image_url ? (
                                <>
                                  <Image
                                    src={m.image_url}
                                    width={140}
                                    style={{ borderRadius: 6, display: 'block' }}
                                    fallback="data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='140' height='90'%3E%3Crect width='140' height='90' fill='%23f0f0f0'/%3E%3Ctext x='70' y='50' font-size='12' fill='%23999' text-anchor='middle'%3E图片加载失败%3C/text%3E%3C/svg%3E"
                                  />
                                  {/* 有些图片是 IM 的私有资源，浏览器里可能加载不出来；给个出口 */}
                                  <Typography.Link href={m.image_url} target="_blank" style={{ fontSize: 11 }}>
                                    打开原图
                                  </Typography.Link>
                                </>
                              ) : (
                                m.text || '（非文本消息）'
                              )}
                            </div>
                            <div className="ais-chat-meta" style={{ textAlign: m.direction === 'out' ? 'right' : 'left' }}>
                              {m.direction === 'out' ? '我方' : '对方'}
                              {m.sender ? ` · ${m.sender}` : ''} · {fmtTime(m.msg_epoch ?? m.captured_at)}
                            </div>
                          </div>
                        </div>
                      ))
                    ) : (
                      <Empty description="暂无往来记录" image={Empty.PRESENTED_IMAGE_SIMPLE} style={{ padding: 30 }} />
                    )}
                  </div>
                </div>

                {(chat.data?.quotes || []).length ? (
                  <div>
                    <Typography.Text strong>报价记录（{chat.data!.quotes.length}）</Typography.Text>
                    <Table
                      size="small"
                      style={{ marginTop: 8 }}
                      rowKey={(r: Record<string, unknown>) => String(r.id)}
                      pagination={false}
                      scroll={{ x: 900 }}
                      tableLayout="fixed"
                      dataSource={chat.data!.quotes}
                      columns={[
                        { title: '页面价', dataIndex: 'page_price', width: 90 },
                        { title: '回复原文', dataIndex: 'raw_text', width: 240, ellipsis: true },
                        { title: '口径', dataIndex: 'price_basis', width: 110 },
                        { title: '可比单价', dataIndex: 'unit_price_final', width: 96 },
                        {
                          title: '状态', dataIndex: 'status', width: 110,
                          render: (v: string) => {
                            const map: Record<string, { text: string; color: string }> = {
                              quoted: { text: '信息已集齐', color: 'green' },
                              dropped: { text: '不做此款', color: 'red' },
                              need_human: { text: '需人工联系', color: 'orange' },
                              give_up: { text: '信息不全', color: 'default' }
                            };
                            return <Tag color={map[v]?.color}>{map[v]?.text || v || '-'}</Tag>;
                          }
                        },
                        {
                          title: '结果说明', dataIndex: 'not_doing_reason', width: 220,
                          ellipsis: true,
                          render: (v: string, row: Record<string, unknown>) =>
                            v || String(row.remark || row.handoff_contact || '-')
                        }
                      ]}
                    />
                  </div>
                ) : null}
              </>
            )}
          </Space>
        ) : null}
      </Drawer>
      {runner.node}
    </>
  );
}
