import { useCallback, useMemo, useState } from 'react';
import {
  Alert, Button, Descriptions, Modal, Popconfirm, Progress, Space, Tag, Typography, message
} from 'antd';
import { ApartmentOutlined } from '@ant-design/icons';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useNavigate } from 'react-router-dom';
import { detailOf, get, post } from '../api/client';
import type { Job } from '../api/types';
import { fmtTime } from '../utils/format';

const RUNNING = ['queued', 'running'];
const STATUS_CN: Record<string, string> = {
  queued: '排队中',
  running: '执行中',
  done: '已完成',
  failed: '失败',
  canceled: '已取消'
};

/**
 * 统一的「长耗时动作」体验：
 *   后端返回 job_id → 这里弹窗轮询进度 → 完成/失败自动提示并刷新列表。
 */
export function useJobRunner(onDone?: () => void) {
  const [jobId, setJobId] = useState<string | null>(null);
  const [open, setOpen] = useState(false);
  const [stopping, setStopping] = useState(false);
  const [resuming, setResuming] = useState(false);
  const qc = useQueryClient();
  const navigate = useNavigate();

  const { data: job } = useQuery({
    queryKey: ['job', jobId],
    queryFn: () => get<Job>(`/api/jobs/${jobId}`),
    enabled: !!jobId && open,
    refetchInterval: (query) => {
      const d = query.state.data as Job | undefined;
      return d && !RUNNING.includes(d.status) ? false : 2000;
    }
  });

  const start = useCallback((id: string) => {
    setJobId(id);
    setOpen(true);
  }, []);

  const close = useCallback(() => {
    setOpen(false);
    onDone?.();
    void qc.invalidateQueries();
  }, [onDone, qc]);

  const running = !!job && RUNNING.includes(job.status);
  const resumable = job?.status === 'failed' && job?.type === 'campaign.fullauto'
    && String(job?.error || '').includes('服务重启');
  const flowRun = useMemo(() => {
    const result = (job?.result || {}) as Record<string, unknown>;
    const flowId = typeof result.flow_id === 'string' ? result.flow_id : '';
    if (!flowId) return null;
    return {
      flowId,
      campaignId: Number(result.campaign || job?.payload?.id || 0) || undefined,
      firstStepKind: String((result.first_step as Record<string, unknown> | undefined)?.kind || '')
    };
  }, [job?.result, job?.payload]);

  const openTaskCenter = useCallback(() => {
    if (!flowRun) return;
    close();
    const params = new URLSearchParams();
    if (flowRun.campaignId) params.set('campaign_id', String(flowRun.campaignId));
    params.set('flow_id', flowRun.flowId);
    navigate(`/task-center?${params.toString()}`);
  }, [close, flowRun, navigate]);

  /* 长耗时作业（自动采集）支持中途停止：只改作业状态，处理器在下一个检查点收尾 */
  const stop = useCallback(async () => {
    if (!jobId) return;
    setStopping(true);
    try {
      const r = await post<{ note?: string }>(`/api/jobs/${jobId}/cancel`, {});
      message.success(r?.note || '已请求停止');
      void qc.invalidateQueries({ queryKey: ['job', jobId] });
    } catch (e) {
      message.error(detailOf(e));
    } finally {
      setStopping(false);
    }
  }, [jobId, qc]);

  /* 服务重启把作业打断后，从中断的轮次续跑：跳过启动阶段，不重复联系商家 */
  const resume = useCallback(async () => {
    if (!jobId) return;
    setResuming(true);
    try {
      const r = await post<{ job: Job }>(`/api/jobs/${jobId}/resume`, {});
      message.success('已从中断处续跑（不会重复联系商家）');
      setJobId(r.job.id);
      void qc.invalidateQueries({ queryKey: ['job'] });
    } catch (e) {
      message.error(detailOf(e));
    } finally {
      setResuming(false);
    }
  }, [jobId, qc]);

  const node = useMemo(
    () => (
      <Modal
        open={open}
        title={
          <Space>
            <span>{flowRun ? '全自动比价' : '作业执行'}</span>
            {job ? (
              <Tag color={running ? 'processing' : job.status === 'done' ? 'success' : 'error'}>
                {STATUS_CN[job.status] || job.status}
              </Tag>
            ) : null}
          </Space>
        }
        onCancel={close}
        footer={[
          ...(running
            ? [
                <Popconfirm
                  key="stop"
                  title="确认停止这个作业？"
                  description="浏览器动作无法中途打断，会在当前这一步跑完后停止。"
                  okText="停止"
                  cancelText="再等等"
                  onConfirm={stop}
                >
                  <Button danger loading={stopping}>
                    停止
                  </Button>
                </Popconfirm>
              ]
            : []),
          ...(resumable
            ? [
                <Button key="resume" type="primary" loading={resuming} onClick={resume}>
                  从中断处续跑
                </Button>
              ]
            : []),
          ...(flowRun
            ? [
                <Button key="task-center" type="primary" icon={<ApartmentOutlined />} onClick={openTaskCenter}>
                  去任务中心查看详情
                </Button>
              ]
            : []),
          <Button key="close" type={running || flowRun ? 'default' : 'primary'} onClick={close}>
            {running ? '后台运行，先关闭' : '关闭'}
          </Button>
        ]}
        width={560}
      >
        <Space direction="vertical" style={{ width: '100%' }} size={12}>
          <Typography.Text type="secondary">
            {flowRun
              ? `整体流程创建于 ${fmtTime(job?.created_at)}`
              : `作业号 ${jobId} · ${job?.type || ''} · 创建于 ${fmtTime(job?.created_at)}`}
          </Typography.Text>
          {flowRun ? (
            <>
              <Alert
                type={job?.status === 'failed' ? 'error' : 'success'}
                showIcon
                message={job?.status === 'failed' ? '流程提交失败' : '全自动比价任务已提交'}
                description={
                  job?.status === 'failed'
                    ? job?.error || '流程创建失败，请到任务中心查看错误详情。'
                    : '系统已创建整体流程，后续将在后台按步骤执行。'
                }
              />
              <Descriptions column={1} size="small" bordered>
                <Descriptions.Item label="任务">
                  {flowRun.campaignId ? `任务 #${flowRun.campaignId}` : '当前全自动比价任务'}
                </Descriptions.Item>
                <Descriptions.Item label="流程号">
                  <Typography.Text copyable>{flowRun.flowId}</Typography.Text>
                </Descriptions.Item>
                <Descriptions.Item label="流程状态">
                  {job?.status === 'failed' ? '创建失败' : '已创建，等待后台调度'}
                </Descriptions.Item>
              </Descriptions>
              <Typography.Text type="secondary">
                整体进度、每一步执行状态、错误信息和子作业日志，请到任务中心查看。
              </Typography.Text>
            </>
          ) : (
            <>
              <Progress
                percent={job?.status === 'done' ? 100 : running ? 60 : 100}
                status={job?.status === 'failed' ? 'exception' : job?.status === 'done' ? 'success' : 'active'}
                showInfo={false}
              />
              <div style={{ fontSize: 13 }}>{job?.progress?.text || '排队中…'}</div>
              {job?.error ? <Alert type="error" showIcon message="执行失败" description={job.error} /> : null}
              {job?.status === 'done' && job.result ? (
                <pre
                  style={{
                    background: '#f6f8fb',
                    borderRadius: 8,
                    padding: 10,
                    fontSize: 12,
                    maxHeight: 220,
                    overflow: 'auto',
                    margin: 0
                  }}
                >
                  {JSON.stringify(job.result, null, 2)}
                </pre>
              ) : null}
            </>
          )}
        </Space>
      </Modal>
    ),
    [open, job, jobId, running, resumable, flowRun, close, stop, stopping, resume, resuming, openTaskCenter]
  );

  return { start, node, jobId, running };
}
