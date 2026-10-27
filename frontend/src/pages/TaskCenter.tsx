import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  Button, Card, Col, Descriptions, Drawer, Empty, Popconfirm, Progress, Row, Select, Space, Steps, Table, Tag,
  Tooltip, Typography, message
} from 'antd';
import {
  ApartmentOutlined, ClockCircleOutlined, PauseCircleOutlined, PlayCircleOutlined, ReloadOutlined,
  StopOutlined
} from '@ant-design/icons';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useSearchParams } from 'react-router-dom';

import StatCard from '../components/StatCard';
import { detailOf, get, post, put } from '../api/client';
import type { Campaign, FlowRun, FlowStep, Job } from '../api/types';
import { fmtTime, stageLabel, statusLabel } from '../utils/format';
import { jobCN } from '../utils/jobLabel';

const STEP_CN: Record<string, string> = {
  advance: '推进 / 联系',
  search: '搜图',
  screen: '标题审核',
  contact: '联系商家',
  collect: '采集解析',
  audit: '补分析 / 推送',
  report: '报表'
};

const STATUS: Record<string, { cn: string; color: string; step: 'wait' | 'process' | 'finish' | 'error' }> = {
  pending: { cn: '待执行', color: 'default', step: 'wait' },
  queued: { cn: '已入队', color: 'gold', step: 'wait' },
  running: { cn: '执行中', color: 'processing', step: 'process' },
  done: { cn: '已完成', color: 'success', step: 'finish' },
  failed: { cn: '失败', color: 'error', step: 'error' },
  canceled: { cn: '已取消', color: 'default', step: 'error' }
};

const statusOf = (s?: string) => STATUS[String(s || '')] || { cn: String(s || '-'), color: 'default', step: 'wait' as const };

function dur(a?: number | null, b?: number | null): string {
  if (!a) return '-';
  const end = b || Date.now();
  const ms = Math.max(0, end - a);
  if (ms < 1000) return `${ms}ms`;
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)}s`;
  return `${Math.floor(ms / 60_000)}分${Math.round((ms % 60_000) / 1000)}秒`;
}

function Json({ value }: { value: unknown }) {
  if (value === null || value === undefined || value === '') return <Typography.Text type="secondary">-</Typography.Text>;
  return (
    <pre style={{ background: '#f6f8fb', borderRadius: 8, padding: 10, fontSize: 12, maxHeight: 280, overflow: 'auto', margin: 0 }}>
      {typeof value === 'string' ? value : JSON.stringify(value, null, 2)}
    </pre>
  );
}

interface RunResp {
  run: FlowRun;
  steps: FlowStep[];
}

interface JobDetail {
  job: Job;
  logs: { at?: number; level?: string; message?: string; source?: string }[];
}

export default function TaskCenter() {
  const qc = useQueryClient();
  const [searchParams] = useSearchParams();
  const queryCampaignId = Number(searchParams.get('campaign_id') || 0) || undefined;
  const queryFlowId = searchParams.get('flow_id') || undefined;
  const [campaignId, setCampaignId] = useState<number | undefined>(queryCampaignId);
  const [flowId, setFlowId] = useState<string | undefined>(queryFlowId);
  const [openStep, setOpenStep] = useState<FlowStep | null>(null);
  const [taskAction, setTaskAction] = useState<'pause' | 'resume' | 'terminate' | null>(null);
  const [refreshing, setRefreshing] = useState(false);

  const campaigns = useQuery({
    queryKey: ['campaigns', 'task-center'],
    queryFn: () => get<{ items: Campaign[] }>('/api/campaigns', { include_archived: true })
  });

  const runs = useQuery({
    queryKey: ['flow-runs', campaignId],
    queryFn: () => get<{ items: FlowRun[] }>('/api/flows/runs', {
      campaign_id: campaignId,
      limit: 50
    }),
    refetchInterval: 5000
  });

  useEffect(() => {
    const items = runs.data?.items || [];
    if (!items.length) {
      if (flowId) setFlowId(undefined);
      return;
    }
    if (!flowId || !items.some((x) => x.id === flowId)) setFlowId(items[0].id);
  }, [runs.data, flowId]);

  const detail = useQuery({
    queryKey: ['flow-run', flowId],
    queryFn: () => get<RunResp>(`/api/flows/runs/${flowId}`),
    enabled: !!flowId,
    refetchInterval: (q) => {
      const d = q.state.data as RunResp | undefined;
      return d?.run?.status === 'running' ? 3000 : 8000;
    }
  });

  const currentJob = openStep?.jobs?.[openStep.jobs.length - 1];
  const jobDetail = useQuery({
    queryKey: ['flow-step-job', currentJob?.id],
    queryFn: () => get<JobDetail>(`/api/jobs/${currentJob?.id}/detail`, { log_limit: 200 }),
    enabled: !!currentJob?.id
  });

  const listRun = runs.data?.items?.find((x) => x.id === flowId);
  const run = detail.data?.run ? { ...listRun, ...detail.data.run } : listRun;
  const selectedCampaign = campaigns.data?.items?.find((c) => c.id === campaignId);
  const steps = detail.data?.steps || [];
  const total = Math.max(1, Number(run?.total_steps || steps.length || 0));
  const done = Number(run?.done_steps ?? steps.filter((s) => s.status === 'done').length);
  const failed = Number(run?.failed_steps ?? steps.filter((s) => s.status === 'failed').length);
  const percent = Math.round((done / total) * 100);
  const runActive = !!run && ['pending', 'queued', 'running'].includes(String(run.status || ''));

  const refreshTaskQueries = useCallback(async () => {
    await Promise.all([
      campaigns.refetch(),
      runs.refetch(),
      flowId ? detail.refetch() : Promise.resolve(null),
    ]);
  }, [campaigns.refetch, runs.refetch, detail.refetch, flowId]);

  useEffect(() => {
    const h = () => void refreshTaskQueries();
    window.addEventListener('ais:refresh', h);
    return () => window.removeEventListener('ais:refresh', h);
  }, [refreshTaskQueries]);

  const refreshTask = async () => {
    if (refreshing) return;
    setRefreshing(true);
    try {
      await refreshTaskQueries();
    } finally {
      setRefreshing(false);
    }
  };

  const toggleTask = async () => {
    if (!selectedCampaign) return;
    const next = selectedCampaign.status === 'running' ? 'paused' : 'running';
    setTaskAction(next === 'paused' ? 'pause' : 'resume');
    try {
      await put(`/api/campaigns/${selectedCampaign.id}`, { status: next });
      message.success(next === 'paused'
        ? '任务已暂停：不会继续创建后续步骤；如需立即收口请使用“终止当前流程”'
        : '任务已恢复运行');
      await refreshTaskQueries();
    } catch (e) {
      message.error(detailOf(e));
    } finally {
      setTaskAction(null);
    }
  };

  const terminateCurrentFlow = async () => {
    if (!flowId) return;
    setTaskAction('terminate');
    try {
      const r = await post<{ note?: string; canceled_steps?: number; canceled_jobs?: string[]; campaign_error?: string }>(
        `/api/flows/runs/${flowId}/terminate`,
        {},
      );
      if (r.campaign_error) {
        message.warning(`流程已终止，但任务暂停失败：${r.campaign_error}`);
      } else {
        message.success(r.note || `流程已终止，取消 ${r.canceled_steps || 0} 个步骤`);
      }
      setOpenStep(null);
      await refreshTaskQueries();
    } catch (e) {
      message.error(detailOf(e));
    } finally {
      setTaskAction(null);
    }
  };

  const stepItems = useMemo(() => steps.map((s) => {
    const info = statusOf(s.status);
    return {
      title: `第 ${s.step_no} 步 · ${STEP_CN[s.kind] || s.kind}`,
      status: info.step,
      description: (
        <Space direction="vertical" size={0}>
          <Typography.Text style={{ fontSize: 12 }}>
            <Tag color={info.color}>{info.cn}</Tag>
            {s.attempts ? `尝试 ${s.attempts} 次` : ''}
            {s.run_after ? ` · 计划 ${fmtTime(s.run_after, true)}` : ''}
          </Typography.Text>
          {s.error ? <Typography.Text type="danger" style={{ fontSize: 11 }}>{s.error}</Typography.Text> : null}
        </Space>
      )
    };
  }), [steps]);

  const columns = [
    { title: '步骤', dataIndex: 'step_no', width: 64, render: (v: number) => `#${v}` },
    { title: '类型', dataIndex: 'kind', width: 130, render: (v: string) => STEP_CN[v] || v },
    {
      title: '状态',
      dataIndex: 'status',
      width: 90,
      render: (v: string) => <Tag color={statusOf(v).color}>{statusOf(v).cn}</Tag>
    },
    { title: '尝试', dataIndex: 'attempts', width: 64, render: (v: number) => v || '-' },
    {
      title: '计划/更新',
      width: 170,
      render: (_: unknown, s: FlowStep) => (
        <Space direction="vertical" size={0}>
          <Typography.Text style={{ fontSize: 12 }}>{s.run_after ? fmtTime(s.run_after, false) : '-'}</Typography.Text>
          <Typography.Text type="secondary" style={{ fontSize: 11 }}>{fmtTime(s.updated_at, false)}</Typography.Text>
        </Space>
      )
    },
    {
      title: '子作业',
      width: 190,
      render: (_: unknown, s: FlowStep) => (
        (s.jobs || []).length ? (
          <Space direction="vertical" size={0}>
            {s.jobs?.slice(-2).map((j) => (
              <Typography.Text key={j.id} style={{ fontSize: 12 }}>
                {jobCN(j.type)} · {statusOf(j.status).cn}
              </Typography.Text>
            ))}
          </Space>
        ) : <Typography.Text type="secondary">-</Typography.Text>
      )
    },
    {
      title: '错误',
      dataIndex: 'error',
      render: (v: string) => <Typography.Text type={v ? 'danger' : 'secondary'} style={{ fontSize: 12 }} ellipsis={{ tooltip: v }}>{v || '-'}</Typography.Text>
    }
  ];

  return (
    <Space direction="vertical" size={16} style={{ width: '100%' }}>
      <Card
        title={<Space><ApartmentOutlined /><span>任务中心</span></Space>}
        extra={
          <Space wrap>
            <Select
              allowClear
              showSearch
              placeholder="选择任务"
              style={{ width: 260 }}
              value={campaignId}
              optionFilterProp="label"
              onChange={(v) => { setCampaignId(v); setFlowId(undefined); }}
              options={(campaigns.data?.items || []).map((c) => ({
                value: c.id,
                label: `#${c.id} ${c.name} · ${c.status || '-'}`
              }))}
            />
            <Select
              placeholder="选择一次流程"
              style={{ width: 300 }}
              value={flowId}
              onChange={setFlowId}
              options={(runs.data?.items || []).map((r) => ({
                value: r.id,
                label: `${r.id} · ${r.status} · ${fmtTime(r.created_at, false)}`
              }))}
            />
            <Button
              icon={<ReloadOutlined />}
              loading={refreshing}
              onClick={() => void refreshTask()}
            >
              刷新
            </Button>
            {selectedCampaign && selectedCampaign.status !== 'archived' ? (
              <Tooltip title={selectedCampaign.status === 'running'
                ? '只暂停后续调度，不立即打断当前浏览器动作'
                : '恢复任务状态；不会自动重启已终止的流程'}>
                <Button
                  icon={selectedCampaign.status === 'running' ? <PauseCircleOutlined /> : <PlayCircleOutlined />}
                  loading={taskAction === 'pause' || taskAction === 'resume'}
                  onClick={toggleTask}
                >
                  {selectedCampaign.status === 'running' ? '暂停任务' : '恢复任务'}
                </Button>
              </Tooltip>
            ) : null}
            {runActive ? (
              <Popconfirm
                title="终止当前流程并暂停任务？"
                description="未执行步骤会取消；当前浏览器动作会在安全检查点退出，已产生的数据和报价会保留。"
                okText="终止"
                cancelText="取消"
                okButtonProps={{ danger: true }}
                onConfirm={terminateCurrentFlow}
              >
                <Button danger icon={<StopOutlined />} loading={taskAction === 'terminate'}>
                  终止当前流程
                </Button>
              </Popconfirm>
            ) : null}
          </Space>
        }
      >
        {selectedCampaign ? (
          <Descriptions size="small" column={{ xs: 1, sm: 2, lg: 4 }}>
            <Descriptions.Item label="任务">
              <Space size={6}>
                <Tag color="blue">#{selectedCampaign.id}</Tag>
                <Typography.Text strong>{selectedCampaign.name}</Typography.Text>
              </Space>
            </Descriptions.Item>
            <Descriptions.Item label="状态">
              <Tag color={selectedCampaign.status === 'running' ? 'success' : selectedCampaign.status === 'paused' ? 'gold' : 'default'}>
                {statusLabel(selectedCampaign.status)}
              </Tag>
            </Descriptions.Item>
            <Descriptions.Item label="阶段">
              {stageLabel(selectedCampaign.stage)}
            </Descriptions.Item>
            <Descriptions.Item label="客户 / 报价 / 可比价">
              {selectedCampaign.contact_count || 0} / {selectedCampaign.quote_count || 0} / {selectedCampaign.priced_count || 0} 家
            </Descriptions.Item>
            <Descriptions.Item label="当前流程">
              {run ? `${run.id} · ${statusOf(run.status).cn} · ${done}/${total} 步` : '暂无流程记录'}
            </Descriptions.Item>
            <Descriptions.Item label="最近更新">
              {fmtTime(selectedCampaign.updated_at)}
            </Descriptions.Item>
          </Descriptions>
        ) : (
          <Typography.Text type="secondary">
            请先选择任务。选择后可查看全自动整体流程、每一步的排队与执行状态、失败原因和子作业详情；
            旧版一条龙作业仍可在日志中心查看。
          </Typography.Text>
        )}
      </Card>

      {campaignId && !runs.isLoading && !(runs.data?.items || []).length ? (
        <Card>
          <Empty description="该任务还没有分步流程记录。重新点击「全自动比价」后会生成流程。" />
        </Card>
      ) : null}

      {run ? (
        <>
          <Row gutter={[16, 16]}>
            <Col xs={12} md={6}><StatCard icon={<ApartmentOutlined />} label="流程状态" value={statusOf(run.status).cn} color={run.status === 'failed' ? '#e5534b' : '#3b6fe0'} hint={run.id} /></Col>
            <Col xs={12} md={6}><StatCard icon={<ClockCircleOutlined />} label="当前步骤" value={run.current_step_no ? `#${run.current_step_no}` : '-'} color="#7a5af8" hint={run.current_kind ? (STEP_CN[run.current_kind] || run.current_kind) : '无待执行步骤'} /></Col>
            <Col xs={12} md={6}><StatCard icon={<span>✓</span>} label="已完成步骤" value={`${done}/${total}`} color="#18a058" hint={`失败 ${failed} 步`} /></Col>
            <Col xs={12} md={6}><StatCard icon={<span>⏱</span>} label="运行用时" value={dur(run.created_at, run.status === 'done' ? run.updated_at : undefined)} color="#d48806" hint={`创建 ${fmtTime(run.created_at, true)}`} /></Col>
          </Row>

          <Card title="整体流程">
            <Row gutter={[20, 16]}>
              <Col xs={24} lg={8}>
                <Descriptions column={1} size="small">
                  <Descriptions.Item label="任务">{run.campaign_name || `#${run.campaign_id}`}</Descriptions.Item>
                  <Descriptions.Item label="任务状态">{run.campaign_status || '-'}{run.campaign_stage ? ` / ${run.campaign_stage}` : ''}</Descriptions.Item>
                  <Descriptions.Item label="流程号"><Typography.Text copyable>{run.id}</Typography.Text></Descriptions.Item>
                  <Descriptions.Item label="进度"><Progress percent={percent} status={failed ? 'exception' : run.status === 'running' ? 'active' : undefined} size="small" /></Descriptions.Item>
                </Descriptions>
              </Col>
              <Col xs={24} lg={16}>
                {stepItems.length ? <Steps direction="vertical" size="small" current={stepItems.findIndex((x) => x.status === 'process')} items={stepItems} /> : <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="暂无步骤" />}
              </Col>
            </Row>
          </Card>

          <Card title="小步骤明细">
            <Table
              rowKey="id"
              size="small"
              dataSource={steps}
              columns={columns}
              pagination={{ pageSize: 20, showSizeChanger: true }}
              onRow={(s) => ({ onClick: () => setOpenStep(s) })}
              rowClassName={() => 'task-center-step-row'}
            />
          </Card>
        </>
      ) : null}

      <Drawer
        width={720}
        open={!!openStep}
        onClose={() => setOpenStep(null)}
        title={openStep ? `第 ${openStep.step_no} 步 · ${STEP_CN[openStep.kind] || openStep.kind}` : '步骤详情'}
      >
        {openStep ? (
          <Space direction="vertical" size={14} style={{ width: '100%' }}>
            <Descriptions column={2} size="small" bordered>
              <Descriptions.Item label="步骤 ID">{openStep.id}</Descriptions.Item>
              <Descriptions.Item label="状态"><Tag color={statusOf(openStep.status).color}>{statusOf(openStep.status).cn}</Tag></Descriptions.Item>
              <Descriptions.Item label="尝试次数">{openStep.attempts || 0}</Descriptions.Item>
              <Descriptions.Item label="计划时间">{openStep.run_after ? fmtTime(openStep.run_after, true) : '-'}</Descriptions.Item>
              <Descriptions.Item label="创建时间">{fmtTime(openStep.created_at, true)}</Descriptions.Item>
              <Descriptions.Item label="更新时间">{fmtTime(openStep.updated_at, true)}</Descriptions.Item>
            </Descriptions>
            {openStep.error ? <Typography.Text type="danger">{openStep.error}</Typography.Text> : null}
            <Card size="small" title="步骤参数">
              <Json value={openStep.payload} />
            </Card>
            <Card size="small" title="关联子作业">
              {(openStep.jobs || []).length ? (
                <Space direction="vertical" size={8} style={{ width: '100%' }}>
                  {(openStep.jobs || []).map((j) => (
                    <div key={j.id}>
                      <Space wrap><Tag>{jobCN(j.type)}</Tag><Tag color={statusOf(j.status).color}>{statusOf(j.status).cn}</Tag><Typography.Text copyable>{j.id}</Typography.Text></Space>
                      {j.error ? <Typography.Text type="danger" style={{ display: 'block' }}>{j.error}</Typography.Text> : null}
                    </div>
                  ))}
                  {jobDetail.data ? (
                    <Card size="small" title="最近子作业日志">
                      {(jobDetail.data.logs || []).slice(-30).map((l, i) => (
                        <div key={`${l.at}-${i}`} style={{ fontSize: 12, marginBottom: 4 }}>
                          <Typography.Text type="secondary">{fmtTime(l.at, false)} </Typography.Text>
                          <Typography.Text type={l.level === 'error' ? 'danger' : undefined}>{l.message}</Typography.Text>
                        </div>
                      ))}
                    </Card>
                  ) : null}
                </Space>
              ) : <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="这一步还没有子作业" />}
            </Card>
          </Space>
        ) : null}
      </Drawer>
    </Space>
  );
}
