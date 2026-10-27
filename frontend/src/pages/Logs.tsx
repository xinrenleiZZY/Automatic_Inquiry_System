import { useEffect, useMemo, useRef, useState } from 'react';
import {
  Alert, Button, Card, Col, Descriptions, Drawer, Empty, Popconfirm, Row, Select, Space, Table, Tabs, Tag, Timeline, Tooltip,
  Typography, message
} from 'antd';
import {
  FileSearchOutlined, HistoryOutlined, HourglassOutlined, PlayCircleOutlined, ReloadOutlined, StopOutlined
} from '@ant-design/icons';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useSearchParams } from 'react-router-dom';

import StatCard from '../components/StatCard';
import { detailOf, get, post } from '../api/client';
import type { AiCallTrace, Job } from '../api/types';
import { fmtTime } from '../utils/format';
import { jobCN } from '../utils/jobLabel';

const STATUS: Record<string, { cn: string; color: string }> = {
  queued: { cn: '排队中', color: 'gold' },
  running: { cn: '执行中', color: 'processing' },
  done: { cn: '已完成', color: 'success' },
  failed: { cn: '失败', color: 'error' },
  canceled: { cn: '已取消', color: 'default' }
};
const statusInfo = (s?: string) => STATUS[String(s || '')] || { cn: String(s || '-'), color: 'default' };

const RUNNING = ['queued', 'running'];
const AI_SOURCE: Record<string, string> = {
  quote_stage1: '报价分析·第一阶段',
  quote_stage2: '报价分析·第二阶段',
  quote_stage1_evidence_repair: '报价分析·一阶段证据重写',
  quote_stage2_evidence_repair: '报价分析·二阶段证据重写',
  session_compact: '历史会话压缩',
  compose_reply: '生成追问回复',
  product_screen: '商品名称审核',
  other: '其他'
};

interface JobDetail {
  job: Job;
  logs: { id?: number; at?: number; level?: string; source?: string; message?: string }[];
  audit: { id?: number; at?: number; username?: string; action?: string; params?: unknown; result?: unknown }[];
}

function dur(a?: number | null, b?: number | null): string {
  if (!a) return '-';
  const end = b || Date.now();
  const ms = end - a;
  if (ms < 0) return '-';
  if (ms < 1000) return `${ms}ms`;
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)}s`;
  return `${Math.floor(ms / 60_000)}分${Math.round((ms % 60_000) / 1000)}秒`;
}

function Json({ value }: { value: unknown }) {
  if (value === null || value === undefined || value === '') return <Typography.Text type="secondary">-</Typography.Text>;
  return (
    <pre style={{ background: '#f6f8fb', borderRadius: 8, padding: 10, fontSize: 12, maxHeight: 240, overflow: 'auto', margin: 0 }}>
      {typeof value === 'string' ? value : JSON.stringify(value, null, 2)}
    </pre>
  );
}

export default function Logs() {
  const qc = useQueryClient();
  const [params, setParams] = useSearchParams();
  const [tab, setTab] = useState('running');
  const [openJob, setOpenJob] = useState<string | null>(null);
  const [stopping, setStopping] = useState(false);
  const [resuming, setResuming] = useState(false);
  const defaultedTab = useRef(false);
  const [aiSource, setAiSource] = useState('');

  /* 支持从别处直接跳进来：/logs?job=<作业号> → 自动打开该作业的详情抽屉
     （顶部失败告警条的「查看详情」就是这么跳的） */
  useEffect(() => {
    const j = params.get('job');
    if (j) {
      setOpenJob(j);
      setTab('history');
    }
  }, [params]);

  const closeDetail = () => {
    setOpenJob(null);
    if (params.get('job')) {
      const next = new URLSearchParams(params);
      next.delete('job');
      setParams(next, { replace: true });
    }
  };

  /* 作业列表：执行中/排队中的时候 3 秒刷一次，历史页 10 秒刷一次（够用又不费） */
  const jobs = useQuery({
    queryKey: ['jobs', 'all'],
    queryFn: () => get<{ items: Job[] }>('/api/jobs', { limit: 200 }),
    refetchInterval: tab === 'history' ? 10000 : 3000
  });
  const summary = useQuery({
    queryKey: ['jobs', 'summary'],
    queryFn: () => get<{ counts: Record<string, number>; current?: { id: string; type: string } | null }>('/api/jobs/summary'),
    refetchInterval: 3000
  });

  const detail = useQuery({
    queryKey: ['job', 'detail', openJob],
    queryFn: () => get<JobDetail>(`/api/jobs/${openJob}/detail`, { log_limit: 300 }),
    enabled: !!openJob,
    refetchInterval: (q) => {
      const d = q.state.data as JobDetail | undefined;
      return d && !RUNNING.includes(String(d.job?.status)) ? false : 2500;
    }
  });
  const aiCalls = useQuery({
    queryKey: ['ai-calls', aiSource],
    queryFn: () => get<{ items: AiCallTrace[]; count: number }>('/api/system/ai-calls', {
      limit: 300,
      source: aiSource || undefined
    }),
    enabled: tab === 'ai-calls',
    refetchInterval: 10000
  });

  /* 后台作业跑完时顺手把列表刷新一下 */
  const runningCount = summary.data?.counts?.running ?? 0;
  useEffect(() => {
    if (!runningCount) void qc.invalidateQueries({ queryKey: ['jobs', 'all'] });
  }, [runningCount, qc]);

  const items = jobs.data?.items || [];
  const queued = useMemo(() => items.filter((j) => j.status === 'queued'), [items]);
  const running = useMemo(() => items.filter((j) => j.status === 'running'), [items]);
  const history = useMemo(
    () => items.filter((j) => !RUNNING.includes(String(j.status))),
    [items]
  );

  /* 没有活动作业时不要让日志中心默认停在空的“执行中”页签；
     自动落到历史日志，只在首次加载时决定一次，之后尊重用户手动切换。 */
  useEffect(() => {
    if (defaultedTab.current || !jobs.isSuccess) return;
    defaultedTab.current = true;
    if (!items.some((j) => RUNNING.includes(String(j.status))) && history.length) {
      setTab('history');
    }
  }, [history.length, items, jobs.isSuccess]);

  const stop = async (id: string) => {
    setStopping(true);
    try {
      const r = await post<{ note?: string }>(`/api/jobs/${id}/cancel`, {});
      message.success(r?.note || '已请求停止');
      void qc.invalidateQueries({ queryKey: ['jobs'] });
      void qc.invalidateQueries({ queryKey: ['job'] });
    } catch (e) {
      message.error(detailOf(e));
    } finally {
      setStopping(false);
    }
  };

  /* 服务重启导致作业中断时，从中断的轮次续跑（跳过联系商家，避免重复询价） */
  const resume = async (id: string) => {
    setResuming(true);
    try {
      const r = await post<{ job: Job }>(`/api/jobs/${id}/resume`, {});
      message.success('已从中断处续跑（不会重复联系商家）');
      setOpenJob(r.job.id);
      setTab('running');
      void qc.invalidateQueries({ queryKey: ['jobs'] });
    } catch (e) {
      message.error(detailOf(e));
    } finally {
      setResuming(false);
    }
  };

  const columns = [
    {
      title: '作业号',
      dataIndex: 'id',
      width: 146,
      render: (v: string) => (
        <Tooltip title={v}>
          <Typography.Text copyable style={{ fontSize: 12.5 }}>
            {String(v || '').slice(0, 14)}
          </Typography.Text>
        </Tooltip>
      )
    },
    { title: '任务动作', dataIndex: 'type', width: 168, render: (v: string) => jobCN(v) },
    {
      title: '状态',
      dataIndex: 'status',
      width: 88,
      render: (v: string) => <Tag color={statusInfo(v).color}>{statusInfo(v).cn}</Tag>
    },
    {
      title: '当前进度',
      width: 240,
      render: (_: unknown, r: Job) => (
        <Typography.Text style={{ fontSize: 12.5 }} ellipsis={{ tooltip: r.progress?.text || '' }}>
          {r.progress?.text || (r.status === 'queued' ? '排队等待执行' : '-')}
        </Typography.Text>
      )
    },
    { title: '发起人', dataIndex: 'created_by', width: 84, render: (v: string) => v || '-' },
    {
      title: '创建 / 用时',
      width: 140,
      render: (_: unknown, r: Job) => (
        <Space direction="vertical" size={0}>
          <Typography.Text style={{ fontSize: 12.5 }}>{fmtTime(r.created_at, false)}</Typography.Text>
          <Typography.Text type="secondary" style={{ fontSize: 11 }}>用时 {dur(r.started_at, r.finished_at)}</Typography.Text>
        </Space>
      )
    },
    {
      title: '操作',
      width: 104,
      render: (_: unknown, r: Job) => (
        <Space size={4}>
          <Tooltip title="详情日志">
            <Button size="small" icon={<FileSearchOutlined />} onClick={() => setOpenJob(r.id)} />
          </Tooltip>
          {RUNNING.includes(String(r.status)) ? (
            <Popconfirm
              title="确认停止这个作业？"
              description="浏览器动作无法中途打断，会在当前这一步跑完后停止。"
              okText="停止"
              cancelText="再等等"
              onConfirm={() => stop(r.id)}
            >
              <Tooltip title="停止">
                <Button size="small" danger loading={stopping} icon={<StopOutlined />} />
              </Tooltip>
            </Popconfirm>
          ) : null}
        </Space>
      )
    }
  ];

  /* 空列表用 Empty 居中显示（别用"只有表头、提示文字飘到最右"的那种样子） */
  const table = (rows: Job[], emptyText: string) => (!rows.length ? (
    <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description={emptyText} style={{ padding: '28px 0' }} />
  ) : (
    <Table
      rowKey="id"
      size="small"
      dataSource={rows}
      columns={columns}
      /* 列宽合计 970：常规窗口能整屏放下（含右侧操作）；更窄的窗口才横向滚动 */
      scroll={{ x: 970 }}
      tableLayout="fixed"
      pagination={{ pageSize: 15, showSizeChanger: true, showTotal: (t) => `共 ${t} 条` }}
      onRow={(r) => ({ onClick: () => setOpenJob(r.id), style: { cursor: 'pointer' } })}
      locale={{ emptyText }}
    />
  ));

  const prettyJson = (value?: string | null) => {
    if (!value) return '';
    try { return JSON.stringify(JSON.parse(value), null, 2); }
    catch { return value; }
  };

  const aiCallTable = () => {
    const rows = aiCalls.data?.items || [];
    if (!rows.length) {
      return <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="还没有 AI 调用记录" style={{ padding: '28px 0' }} />;
    }
    return (
      <Table<AiCallTrace>
        rowKey="id"
        size="small"
        dataSource={rows}
        loading={aiCalls.isLoading}
        pagination={{ pageSize: 20, showSizeChanger: true, showTotal: (total) => `共 ${total} 条` }}
        scroll={{ x: 1180 }}
        expandable={{
          expandedRowRender: (record) => (
            <Space direction="vertical" size={12} style={{ width: '100%' }}>
              <Descriptions size="small" column={3} bordered>
                <Descriptions.Item label="请求 ID">{record.request_id}</Descriptions.Item>
                <Descriptions.Item label="HTTP">{record.http_status || '-'}</Descriptions.Item>
                <Descriptions.Item label="尝试次数">{record.attempts || 0}</Descriptions.Item>
                <Descriptions.Item label="任务">#{record.campaign_id || 0}</Descriptions.Item>
                <Descriptions.Item label="会话">{record.conv_key || '-'}</Descriptions.Item>
                <Descriptions.Item label="作业">{record.job_id || '-'}</Descriptions.Item>
              </Descriptions>
              <div>
                <Typography.Text strong>请求提示词</Typography.Text>
                <Json value={prettyJson(record.request_json)} />
              </div>
              <div>
                <Typography.Text strong>模型最终内容</Typography.Text>
                <Json value={record.response_content || '（无）'} />
              </div>
              <div>
                <Typography.Text strong>用量与上下文</Typography.Text>
                <Json value={{
                  usage: prettyJson(record.usage_json),
                  meta: prettyJson(record.meta_json),
                  request_chars: record.request_chars,
                  request_hash: record.request_hash
                }} />
              </div>
              {record.error ? <Alert type="error" showIcon message="调用错误" description={record.error} /> : null}
            </Space>
          )
        }}
        columns={[
          {
            title: '调用时间',
            dataIndex: 'epoch',
            width: 165,
            render: (value: number) => fmtTime(value, false)
          },
          {
            title: '类型',
            dataIndex: 'source',
            width: 220,
            render: (value: string) => <Tag color="blue">{AI_SOURCE[value] || value}</Tag>
          },
          {
            title: '状态',
            dataIndex: 'status',
            width: 90,
            render: (value: string) => <Tag color={value === 'success' ? 'success' : 'error'}>{value}</Tag>
          },
          { title: '模型', dataIndex: 'model', width: 150 },
          {
            title: '关联',
            width: 180,
            render: (_: unknown, row: AiCallTrace) => (
              <Typography.Text style={{ fontSize: 12 }} ellipsis={{ tooltip: row.conv_key || '' }}>
                任务 #{row.campaign_id || 0}{row.conv_key ? ` · ${row.conv_key}` : ''}
              </Typography.Text>
            )
          },
          {
            title: '耗时',
            dataIndex: 'elapsed_ms',
            width: 100,
            render: (value: number) => `${value || 0} ms`
          },
          {
            title: 'Tokens',
            width: 150,
            render: (_: unknown, row: AiCallTrace) => (
              `输入 ${row.prompt_tokens ?? 0} / 输出 ${row.completion_tokens ?? 0}`
            )
          },
          {
            title: '提示词 / 响应长度',
            width: 170,
            render: (_: unknown, row: AiCallTrace) => `${row.request_chars || 0} / ${(row.response_content || '').length} 字符`
          }
        ]}
      />
    );
  };

  const d = detail.data;
  const runningJob = d ? RUNNING.includes(String(d.job?.status)) : false;

  return (
      <Space direction="vertical" size={16} style={{ width: '100%' }}>
      {/* 三张卡等宽等高：用 Row/Col 栅格（跟首页仪表盘一致），不要用 Space —— 会被 hint 文字撑成不等宽 */}
      <Row gutter={[16, 16]}>
        <Col xs={24} sm={12} lg={8}>
          <StatCard
            icon={<HourglassOutlined />}
            label="排队中"
            value={summary.data?.counts?.queued ?? queued.length}
            color="#e6a23c"
            hint="等待执行的作业"
          />
        </Col>
        <Col xs={24} sm={12} lg={8}>
          <StatCard
            icon={<PlayCircleOutlined />}
            label="执行中"
            value={summary.data?.counts?.running ?? running.length}
            color="#3b6fe0"
            hint={summary.data?.current ? `当前：${jobCN(summary.data.current.type)}` : '队列空闲'}
          />
        </Col>
        <Col xs={24} sm={12} lg={8}>
          <StatCard
            icon={<HistoryOutlined />}
            label="历史任务"
            value={(summary.data?.counts?.done ?? 0) + (summary.data?.counts?.failed ?? 0) + (summary.data?.counts?.canceled ?? 0)}
            color="#7a5af8"
            hint={`成功 ${summary.data?.counts?.done ?? 0} ｜ 失败 ${summary.data?.counts?.failed ?? 0} ｜ 取消 ${summary.data?.counts?.canceled ?? 0}`}
          />
        </Col>
      </Row>

      <Card
        title="日志中心"
        extra={
          <Space>
            <Typography.Text type="secondary" style={{ fontSize: 12 }}>
              后台任务（自动采集 / 全自动比价）的状态与运行日志都在这里
            </Typography.Text>
            <Button icon={<ReloadOutlined />} onClick={() => {
              void qc.invalidateQueries({ queryKey: ['jobs'] });
              void qc.invalidateQueries({ queryKey: ['ai-calls'] });
            }}>
              刷新
            </Button>
          </Space>
        }
        styles={{ body: { paddingTop: 8 } }}
      >
        <Tabs
          activeKey={tab}
          onChange={setTab}
          items={[
            {
              key: 'queued',
              label: `排队中${queued.length ? `（${queued.length}）` : ''}`,
              children: table(queued, '队列里没有等待中的作业')
            },
            {
              key: 'running',
              label: `执行中${running.length ? `（${running.length}）` : ''}`,
              children: table(running, '当前没有正在执行的作业（后台任务跑起来后会出现在这里）')
            },
            {
              key: 'history',
              label: `历史任务${history.length ? `（${history.length}）` : ''}`,
              children: table(history, '还没有历史作业')
            },
            {
              key: 'ai-calls',
              label: `AI 调用${aiCalls.data?.count ? `（${aiCalls.data.count}）` : ''}`,
              children: (
                <Space direction="vertical" size={12} style={{ width: '100%' }}>
                  <Select
                    allowClear
                    placeholder="筛选 AI 调用类型"
                    style={{ width: 260 }}
                    value={aiSource || undefined}
                    onChange={(value?: string) => setAiSource(value || '')}
                    options={Object.entries(AI_SOURCE).map(([value, label]) => ({ value, label }))}
                  />
                  {aiCallTable()}
                </Space>
              )
            }
          ]}
        />
      </Card>

      <Drawer
        open={!!openJob}
        onClose={closeDetail}
        width={760}
        title={
          <Space>
            <span>作业详情</span>
            {d ? <Tag color={statusInfo(d.job.status).color}>{statusInfo(d.job.status).cn}</Tag> : null}
            <Typography.Text type="secondary" style={{ fontSize: 12 }}>
              {openJob}
            </Typography.Text>
          </Space>
        }
        extra={
          openJob && runningJob ? (
            <Popconfirm
              title="确认停止这个作业？"
              description="浏览器动作无法中途打断，会在当前这一步跑完后停止。"
              okText="停止"
              cancelText="再等等"
              onConfirm={() => stop(openJob)}
            >
              <Button danger loading={stopping} icon={<StopOutlined />}>
                停止
              </Button>
            </Popconfirm>
          ) : (
            <Space>
              {openJob && d?.job.status === 'failed' && d?.job.type === 'campaign.fullauto'
                && String(d?.job.error || '').includes('服务重启') ? (
                <Button type="primary" icon={<PlayCircleOutlined />} loading={resuming} onClick={() => void resume(openJob)}>
                  从中断处续跑
                </Button>
              ) : null}
              <Button icon={<ReloadOutlined />} onClick={() => void detail.refetch()}>
                刷新日志
              </Button>
            </Space>
          )
        }
      >
        {d ? (
          <Space direction="vertical" size={14} style={{ width: '100%' }}>
            <Descriptions size="small" column={2} bordered>
              <Descriptions.Item label="任务动作">{jobCN(d.job.type)}</Descriptions.Item>
              <Descriptions.Item label="发起人">{d.job.created_by || '-'}</Descriptions.Item>
              <Descriptions.Item label="创建时间">{fmtTime(d.job.created_at, false)}</Descriptions.Item>
              <Descriptions.Item label="开始时间">{fmtTime(d.job.started_at, false)}</Descriptions.Item>
              <Descriptions.Item label="结束时间">{fmtTime(d.job.finished_at, false)}</Descriptions.Item>
              <Descriptions.Item label="用时">{dur(d.job.started_at, d.job.finished_at)}</Descriptions.Item>
            </Descriptions>

            <div>
              <Typography.Text strong>当前进度</Typography.Text>
              <div style={{ marginTop: 6 }}>
                <Tag color={statusInfo(d.job.status).color}>{statusInfo(d.job.status).cn}</Tag>
                <Typography.Text>{d.job.progress?.text || '（暂无进度文本）'}</Typography.Text>
              </div>
            </div>

            {d.job.error ? <Alert type="error" showIcon message="执行失败" description={d.job.error} /> : null}

            <div>
              <Typography.Text strong>参数</Typography.Text>
              <div style={{ marginTop: 6 }}>
                <Json value={d.job.payload} />
              </div>
            </div>

            {d.job.result ? (
              <div>
                <Typography.Text strong>执行结果</Typography.Text>
                <div style={{ marginTop: 6 }}>
                  <Json value={d.job.result} />
                </div>
              </div>
            ) : null}

            <div>
              <Typography.Text strong>运行日志（{d.logs.length} 条）</Typography.Text>
              <div style={{ marginTop: 8, maxHeight: 320, overflow: 'auto' }}>
                {d.logs.length ? (
                  <Timeline
                    items={d.logs.map((x) => ({
                      color: x.level === 'error' ? 'red' : x.level === 'warn' ? 'orange' : 'blue',
                      children: (
                        <div style={{ fontSize: 12.5 }}>
                          <Space size={6}>
                            <Tag color={x.level === 'error' ? 'error' : x.level === 'warn' ? 'warning' : 'blue'}>
                              {x.level || 'info'}
                            </Tag>
                            <Typography.Text type="secondary">{fmtTime(x.at)}</Typography.Text>
                            <Typography.Text type="secondary">{x.source}</Typography.Text>
                          </Space>
                          <div style={{ marginTop: 4, whiteSpace: 'pre-wrap', wordBreak: 'break-all' }}>{x.message}</div>
                        </div>
                      )
                    }))}
                  />
                ) : (
                  <Typography.Text type="secondary">
                    这个作业没有单独日志（旧作业只在队列层面记了一条；新作业会逐条记录）
                  </Typography.Text>
                )}
              </div>
            </div>

            {d.audit?.length ? (
              <div>
                <Typography.Text strong>相关审计</Typography.Text>
                <div style={{ marginTop: 6 }}>
                  <Json value={d.audit} />
                </div>
              </div>
            ) : null}
          </Space>
        ) : (
          <Typography.Text type="secondary">加载中…</Typography.Text>
        )}
      </Drawer>
    </Space>
  );
}
