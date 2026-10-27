import { useMemo, useState } from 'react';
import {
  Alert, Card, Col, Descriptions, Empty, Input, Row, Space, Table, Tabs, Tag, Typography
} from 'antd';
import { BookOutlined, SafetyCertificateOutlined, SearchOutlined } from '@ant-design/icons';
import { useQuery } from '@tanstack/react-query';

import StatCard from '../components/StatCard';
import { get } from '../api/client';
import { fmtTime } from '../utils/format';

interface KbRule {
  id: string;
  intent: string;
  match_any?: string[];
  action: string;
  risk_level?: string;
  required_slots?: string[];
  template?: string;
  reason?: string;
  max_auto_replies?: number;
  on_missing?: string;
  on_repeat?: string;
  exact_template_only?: boolean;
  hit_count?: number;
}

interface Redline {
  id: string;
  match_any?: string[];
  action: string;
  reason: string;
}

interface RecentHit {
  epoch: number;
  shop: string;
  inbound: string;
  action: string;
  risk: string;
  rule_id: string;
  reply: string;
}

interface KnowledgeData {
  version: string;
  source: string;
  principles: string[];
  faq_rules: KbRule[];
  redlines: Redline[];
  field_mappings: Record<string, string>;
  parsing_rules: string[];
  guards: Record<string, unknown>;
  stats: { faq_rules: number; redlines: number; principles: number; hits: number };
  recent_hits: RecentHit[];
  file: string;
}

const actionCN: Record<string, string> = {
  auto_reply: '固定模板回复',
  human: '转人工',
  block: '硬拦截',
  ignore: '忽略',
  drop: '放弃客户'
};

const riskColor = (risk?: string) => risk === 'high' ? 'red' : risk === 'medium' ? 'orange' : 'green';

export default function KnowledgeBase() {
  const [keyword, setKeyword] = useState('');
  const q = useQuery({
    queryKey: ['inquiry-knowledge'],
    queryFn: () => get<KnowledgeData>('/api/ai/knowledge'),
  });
  const data = q.data;

  const rules = useMemo(() => {
    const items = data?.faq_rules || [];
    const k = keyword.trim().toLowerCase();
    if (!k) return items;
    return items.filter((r) =>
      [r.id, r.intent, r.action, r.template || '', ...(r.match_any || [])]
        .join(' ').toLowerCase().includes(k),
    );
  }, [data?.faq_rules, keyword]);

  const ruleColumns = [
    {
      title: '规则',
      width: 190,
      render: (_: unknown, r: KbRule) => (
        <Space direction="vertical" size={1}>
          <Typography.Text strong>{r.id}</Typography.Text>
          <Typography.Text type="secondary" style={{ fontSize: 11 }}>{r.intent}</Typography.Text>
        </Space>
      ),
    },
    {
      title: '触发内容',
      render: (_: unknown, r: KbRule) => (
        <Space size={[4, 4]} wrap>
          {(r.match_any || []).map((x) => <Tag key={x}>{x}</Tag>)}
        </Space>
      ),
    },
    {
      title: '动作',
      width: 120,
      render: (_: unknown, r: KbRule) => <Tag color={r.action === 'auto_reply' ? 'blue' : 'orange'}>{actionCN[r.action] || r.action}</Tag>,
    },
    {
      title: '风险',
      width: 80,
      render: (_: unknown, r: KbRule) => <Tag color={riskColor(r.risk_level)}>{r.risk_level || '-'}</Tag>,
    },
    {
      title: '固定回答 / 处理',
      render: (_: unknown, r: KbRule) => (
        <Typography.Text style={{ fontSize: 12 }}>
          {r.template || r.reason || '-'}
          {r.required_slots?.length ? (
            <Typography.Text type="secondary" style={{ display: 'block', fontSize: 11 }}>
              必需参数：{r.required_slots.join('、')}{r.on_missing ? ` · 缺失时：${r.on_missing}` : ''}
            </Typography.Text>
          ) : null}
        </Typography.Text>
      ),
    },
    {
      title: '回复上限',
      width: 86,
      render: (_: unknown, r: KbRule) => r.max_auto_replies ?? '-',
    },
    {
      title: '命中',
      width: 70,
      render: (_: unknown, r: KbRule) => r.hit_count || 0,
    },
  ];

  const redlineColumns = [
    {
      title: '红线',
      width: 190,
      render: (_: unknown, r: Redline) => <Typography.Text strong>{r.id}</Typography.Text>,
    },
    {
      title: '触发词',
      render: (_: unknown, r: Redline) => (
        <Space size={[4, 4]} wrap>{(r.match_any || []).map((x) => <Tag color="red" key={x}>{x}</Tag>)}</Space>
      ),
    },
    {
      title: '动作',
      width: 100,
      render: (_: unknown, r: Redline) => <Tag color="red">{actionCN[r.action] || r.action}</Tag>,
    },
    { title: '原因', dataIndex: 'reason' },
  ];

  const hitColumns = [
    { title: '时间', dataIndex: 'epoch', width: 155, render: (v: number) => fmtTime(v) },
    { title: '商家', dataIndex: 'shop', width: 150 },
    { title: '客户原话', dataIndex: 'inbound', ellipsis: true },
    { title: '规则', dataIndex: 'rule_id', width: 160 },
    {
      title: '动作',
      dataIndex: 'action',
      width: 90,
      render: (v: string) => <Tag>{actionCN[v] || v || '-'}</Tag>,
    },
  ];

  return (
    <Space direction="vertical" size={16} style={{ width: '100%' }}>
      <Card
        loading={q.isLoading}
        title={<Space><BookOutlined /><span>1688 询价业务知识库</span></Space>}
        extra={data ? <Space><Tag color="blue">v{data.version}</Tag><Tag>{data.source}</Tag></Space> : null}
      >
        <Row gutter={[14, 14]} style={{ marginBottom: 16 }}>
          <Col xs={12} md={6}>
            <StatCard icon={<BookOutlined />} label="固定规则" value={data?.stats.faq_rules || 0} color="#3b6fe0" hint="FAQ / 业务答复" />
          </Col>
          <Col xs={12} md={6}>
            <StatCard icon={<SafetyCertificateOutlined />} label="风险红线" value={data?.stats.redlines || 0} color="#e5534b" hint="优先于固定规则" />
          </Col>
          <Col xs={12} md={6}>
            <StatCard icon={<span>✓</span>} label="知识库命中" value={data?.stats.hits || 0} color="#18a058" hint="最近 500 条回复留痕" />
          </Col>
          <Col xs={12} md={6}>
            <StatCard icon={<SearchOutlined />} label="业务原则" value={data?.stats.principles || 0} color="#7a5af8" hint="只采集，不自由发挥" />
          </Col>
        </Row>
        <Alert
          type="info"
          showIcon
          message="生效原则"
          description={
            <Space direction="vertical" size={2}>
              {(data?.principles || []).map((x) => <Typography.Text key={x}>• {x}</Typography.Text>)}
              <Typography.Text type="secondary">文件：{data?.file || '-'}</Typography.Text>
            </Space>
          }
        />
      </Card>

      <Card>
        <Tabs
          items={[
            {
              key: 'rules',
              label: `回复规则 ${data?.faq_rules.length || 0}`,
              children: (
                <Space direction="vertical" size={12} style={{ width: '100%' }}>
                  <Input
                    allowClear
                    prefix={<SearchOutlined />}
                    placeholder="搜索规则 ID、触发词、动作或回答内容"
                    value={keyword}
                    onChange={(e) => setKeyword(e.target.value)}
                    style={{ maxWidth: 420 }}
                  />
                  <Table
                    rowKey="id"
                    size="small"
                    dataSource={rules}
                    columns={ruleColumns}
                    pagination={false}
                    scroll={{ x: 1100 }}
                    expandable={{
                      expandedRowRender: (r) => (
                        <Descriptions size="small" column={2}>
                          <Descriptions.Item label="动作"> {actionCN[r.action] || r.action}</Descriptions.Item>
                          <Descriptions.Item label="重复处理">{r.on_repeat || '按最大次数转人工'}</Descriptions.Item>
                          <Descriptions.Item label="精确模板">{r.exact_template_only ? '是，禁止改写' : '否'}</Descriptions.Item>
                          <Descriptions.Item label="命中次数">{r.hit_count || 0}</Descriptions.Item>
                        </Descriptions>
                      ),
                    }}
                  />
                </Space>
              ),
            },
            {
              key: 'redlines',
              label: `风险红线 ${data?.redlines.length || 0}`,
              children: (
                <Table rowKey="id" size="small" dataSource={data?.redlines || []} columns={redlineColumns} pagination={false} />
              ),
            },
            {
              key: 'parsing',
              label: '解析与护栏',
              children: data ? (
                <Row gutter={[16, 16]}>
                  <Col xs={24} lg={12}>
                    <Card size="small" title="报价解析规则">
                      <Space direction="vertical">{data.parsing_rules.map((x) => <Typography.Text key={x}>• {x}</Typography.Text>)}</Space>
                    </Card>
                  </Col>
                  <Col xs={24} lg={12}>
                    <Card size="small" title="字段映射与对话护栏">
                      <Descriptions size="small" column={1}>
                        {Object.entries(data.field_mappings || {}).map(([k, v]) => (
                          <Descriptions.Item key={k} label={k}>{v}</Descriptions.Item>
                        ))}
                        {Object.entries(data.guards || {}).map(([k, v]) => (
                          <Descriptions.Item key={k} label={k}>{String(v)}</Descriptions.Item>
                        ))}
                      </Descriptions>
                    </Card>
                  </Col>
                </Row>
              ) : <Empty />,
            },
            {
              key: 'hits',
              label: `最近命中 ${data?.recent_hits.length || 0}`,
              children: (
                <Table
                  rowKey={(r) => `${r.epoch}-${r.rule_id}`}
                  size="small"
                  dataSource={data?.recent_hits || []}
                  columns={hitColumns}
                  pagination={false}
                  scroll={{ x: 820 }}
                />
              ),
            },
          ]}
        />
      </Card>
    </Space>
  );
}
