import { useEffect, useMemo } from 'react';
import { Card, Col, Empty, List, Row, Space, Tag, Tooltip, Typography } from 'antd';
import {
  ApiOutlined,
  CloudServerOutlined,
  CommentOutlined,
  DollarOutlined,
  FileSearchOutlined,
  MessageOutlined,
  ProfileOutlined,
  QuestionCircleOutlined,
  ReloadOutlined,
  ShopOutlined,
  TeamOutlined
} from '@ant-design/icons';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import type { EChartsOption } from 'echarts';
import { Link } from 'react-router-dom';

import Chart from '../components/Chart';
import StatCard from '../components/StatCard';
import { get } from '../api/client';
import type { Counts, Flows } from '../api/types';
import { fmtTime } from '../utils/format';

interface StatusResp {
  counts: Counts;
  stats: { per_day?: Array<{ d: string; inbound: number; outbound: number }>; last_heartbeat?: Record<string, unknown> | null };
  jobs: { queued: number; running: number; total: number };
  at: number;
}

interface HealthResp {
  ok: boolean;
  components: Record<string, Record<string, unknown>>;
}

/** 一条「新闻」事件：某客户回复让比价表新增了字段（不是聊天记录）。 */
interface NewsItem {
  id: number;
  epoch: number;
  type: string;
  conv?: string;
  conv_key?: string;
  text?: string;
  descr?: string;
  raw?: string;
}

export default function Dashboard() {
  const qc = useQueryClient();
  const status = useQuery({
    queryKey: ['system-status'],
    queryFn: () => get<StatusResp>('/api/system/status'),
    refetchInterval: 5000
  });
  const health = useQuery({
    queryKey: ['system-health'],
    queryFn: () => get<HealthResp>('/api/system/health'),
    refetchInterval: 5000
  });
  const flows = useQuery({
    queryKey: ['flows'],
    queryFn: () => get<Flows>('/api/flows'),
    refetchInterval: 5000
  });
  const events = useQuery({
    queryKey: ['events'],
    queryFn: () => get<{ items: NewsItem[] }>('/api/system/news', { limit: 50 }),
    refetchInterval: 10000
  });

  useEffect(() => {
    const h = () => void qc.invalidateQueries();
    window.addEventListener('ais:refresh', h);
    return () => window.removeEventListener('ais:refresh', h);
  }, [qc]);

  const counts = status.data?.counts;
  const perDay = status.data?.stats?.per_day || [];

  const chartOption = useMemo<EChartsOption>(
    () => ({
      grid: { left: 44, right: 18, top: 34, bottom: 30 },
      tooltip: { trigger: 'axis' },
      legend: { data: ['对方消息', '我方消息'], right: 6, top: 2, itemWidth: 12, itemHeight: 8, textStyle: { fontSize: 12 } },
      xAxis: {
        type: 'category',
        data: perDay.map((d) => d.d),
        axisLine: { lineStyle: { color: '#dfe5ee' } },
        axisLabel: { color: '#8b98ad', fontSize: 11 }
      },
      yAxis: {
        type: 'value',
        splitLine: { lineStyle: { color: '#f0f3f8' } },
        axisLabel: { color: '#8b98ad', fontSize: 11 }
      },
      series: [
        {
          name: '对方消息',
          type: 'bar',
          stack: 'x',
          barMaxWidth: 22,
          itemStyle: { color: '#3b6fe0', borderRadius: [0, 0, 4, 4] },
          data: perDay.map((d) => d.inbound || 0)
        },
        {
          name: '我方消息',
          type: 'bar',
          stack: 'x',
          barMaxWidth: 22,
          itemStyle: { color: '#7a5af8', borderRadius: [4, 4, 0, 0] },
          data: perDay.map((d) => d.outbound || 0)
        }
      ]
    }),
    [perDay]
  );

  const COMPONENTS: Array<[string, string]> = [
    ['im_db', '事实数据库 im.db'],
    ['api_db', '系统库 api.db'],
    ['cdp', 'Chrome 调试端口 6901'],
    ['browser_login', '1688 登录态'],
    ['bridge', 'Node 桥接进程'],
    ['queue', '串行队列'],
    ['monitor', '常驻消息监听']
  ];

  const comp = health.data?.components || {};
  const compOk = (k: string): boolean => {
    const c = comp[k] as { ok?: boolean; reachable?: boolean } | undefined;
    if (!c) return false;
    return Boolean(c.ok ?? c.reachable);
  };

  return (
    <Space direction="vertical" size={16} style={{ width: '100%' }}>
      <Row gutter={[16, 16]}>
        <Col xs={24} sm={12} lg={6} xl={5}>
          <StatCard icon={<TeamOutlined />} label="客户数" value={counts?.conversations ?? '-'} color="#3b6fe0" hint="会话列表去重后的联系人数" />
        </Col>
        <Col xs={24} sm={12} lg={6} xl={5}>
          <StatCard icon={<MessageOutlined />} label="累计消息" value={counts?.messages ?? '-'} color="#7a5af8" hint="入库的消息条数" />
        </Col>
        <Col xs={24} sm={12} lg={6} xl={5}>
          <StatCard icon={<ProfileOutlined />} label="比价任务" value={counts?.campaigns ?? '-'} color="#17a2b8" hint="图片 + 快捷短语绑定" />
        </Col>
        <Col xs={24} sm={12} lg={6} xl={4}>
          <StatCard icon={<ShopOutlined />} label="已联系商家" value={counts?.image_contacts ?? '-'} color="#e6a23c" hint="已打开会话触达的商家" />
        </Col>
        <Col xs={24} sm={12} lg={6} xl={5}>
          <StatCard icon={<DollarOutlined />} label="报价条数" value={counts?.supplier_quotes ?? '-'} color="#18a058" hint="供应商回复解析结果" />
        </Col>
      </Row>

      <Row gutter={[16, 16]}>
        <Col xs={24} lg={15}>
          <Card
            title={
              <Space>
                <CommentOutlined />
                近 14 天消息量
              </Space>
            }
            extra={
              <Tooltip title="点右上角刷新图标可立即更新">
                <ReloadOutlined style={{ color: '#93a0b5' }} />
              </Tooltip>
            }
            styles={{ body: { paddingTop: 6 } }}
          >
            {perDay.length ? <Chart option={chartOption} height={272} /> : <Empty description="暂无消息数据" style={{ padding: 40 }} />}
          </Card>
        </Col>
        <Col xs={24} lg={9}>
          <Card title={<Space><CloudServerOutlined />系统组件</Space>} styles={{ body: { paddingTop: 10 } }}>
            {COMPONENTS.map(([key, label]) => {
              const ok = compOk(key);
              const c = (comp[key] || {}) as Record<string, unknown>;
              return (
                <div className="ais-health-row" key={key}>
                  <span>
                    <span className={ok ? 'ais-dot ok' : 'ais-dot bad'} />
                    {label}
                  </span>
                  <span style={{ color: '#8b98ad', fontSize: 12 }}>
                    {key === 'bridge' && c.pid ? `PID ${c.pid}` : null}
                    {key === 'monitor' && c.pid ? `PID ${c.pid}` : null}
                    {key === 'queue' && flows.data ? `深度 ${flows.data.queue.depth}` : null}
                    {key === 'cdp' && c.browser ? String(c.browser).split(' ')[0] : null}
                    {key === 'browser_login' ? (c.logged_in ? String(c.account || '已登录') : '未登录') : null}
                    {!ok ? '异常' : ''}
                  </span>
                </div>
              );
            })}
            <div style={{ marginTop: 12, paddingTop: 10, borderTop: '1px dashed #e8ecf3', fontSize: 12, color: '#8b98ad' }}>
              监听：{flows.data?.monitor.alive ? '运行中' : '未运行'} · 轮询 {flows.data?.monitor.interval_sec ?? '-'}s ·
              刷新 {flows.data?.monitor.refresh_min ?? 0} 分钟（0 = 交由队列在空闲点刷新）
              {' · '}
              <Link to="/monitor">去状态监控</Link>
            </div>
          </Card>
        </Col>
      </Row>

      <Row gutter={[16, 16]}>
        <Col xs={24} lg={12}>
          <Card
            title={<Space><FileSearchOutlined />最近事件</Space>}
            extra={
              <Tooltip title="只有「客户回复让比价表新增了字段」才算一次事件（新闻），聊天记录不计。最多可见 4 条，可用滚轮查看更多">
                <QuestionCircleOutlined style={{ color: '#93a0b5' }} />
              </Tooltip>
            }
            styles={{ body: { padding: events.data?.items?.length ? 0 : 24 } }}
          >
            {events.data?.items?.length ? (
              <div className="ais-news">
                <List
                  size="small"
                  dataSource={events.data.items}
                  renderItem={(e) => (
                    <List.Item className="ais-news-item">
                      <div className="ais-news-line">
                        <Tag color="blue" style={{ marginInlineEnd: 0 }}>比价更新</Tag>
                        <Typography.Text strong style={{ fontSize: 13 }} ellipsis>
                          {e.conv || e.descr || '-'}
                        </Typography.Text>
                        <span className="ais-news-time">{fmtTime(e.epoch, false)}</span>
                      </div>
                      <Typography.Text className="ais-news-detail" ellipsis={{ tooltip: e.text }}>
                        新增字段：{e.text || '-'}
                      </Typography.Text>
                    </List.Item>
                  )}
                />
              </div>
            ) : (
              <Empty description="暂无事件（客户回复新增比价表字段后才会有）" image={Empty.PRESENTED_IMAGE_SIMPLE} />
            )}
          </Card>
        </Col>
        <Col xs={24} lg={12}>
          <Card title={<Space><ApiOutlined />队列与作业</Space>} styles={{ body: { paddingTop: 12 } }}>
            <Row gutter={16}>
              <Col span={8}>
                <StatCard icon={<ApiOutlined />} label="排队中" value={status.data?.jobs.queued ?? 0} color="#e6a23c" />
              </Col>
              <Col span={8}>
                <StatCard icon={<ApiOutlined />} label="执行中" value={status.data?.jobs.running ?? 0} color="#3b6fe0" />
              </Col>
              <Col span={8}>
                <StatCard icon={<ApiOutlined />} label="历史作业" value={status.data?.jobs.total ?? 0} color="#18a058" />
              </Col>
            </Row>
            <div style={{ marginTop: 16 }}>
              <div className="ais-health-row">
                <span>队列状态</span>
                <Tag color={flows.data?.queue.running ? 'success' : 'default'}>
                  {flows.data?.queue.running ? '运行中' : '已停止'}
                  {flows.data?.queue.paused ? '（已暂停）' : ''}
                </Tag>
              </div>
              <div className="ais-health-row">
                <span>当前作业</span>
                <span style={{ color: '#8b98ad', fontSize: 12 }}>{flows.data?.queue.current?.type || '空闲'}</span>
              </div>
              <div className="ais-health-row">
                <span>已完成 / 失败</span>
                <span style={{ fontSize: 12 }}>
                  {(flows.data?.queue.processed ?? 0) + ' / '}
                  <span style={{ color: (flows.data?.queue.failed ?? 0) > 0 ? '#e5534b' : '#18a058' }}>
                    {flows.data?.queue.failed ?? 0}
                  </span>
                </span>
              </div>
              <div className="ais-health-row">
                <span>桥接调用次数</span>
                <span style={{ color: '#8b98ad', fontSize: 12 }}>
                  {flows.data?.bridge.calls ?? 0} 次 · 重启 {flows.data?.bridge.restarts ?? 0} 次
                </span>
              </div>
            </div>
          </Card>
        </Col>
      </Row>
    </Space>
  );
}
