import { useEffect, useMemo, useState } from 'react';
import { Button, Card, Col, DatePicker, Dropdown, Input, Row, Segmented, Select, Space, Switch, Table, Tag, Tooltip, Typography } from 'antd';
import { DownloadOutlined, ReloadOutlined } from '@ant-design/icons';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import dayjs, { type Dayjs } from 'dayjs';

import StatCard from '../components/StatCard';
import { get } from '../api/client';
import type { Campaign, CompareRow } from '../api/types';
import { basisLabel, fmtMoney, fmtTime, verdictColor } from '../utils/format';

interface CompareResp {
  items: CompareRow[];
  summary: {
    total: number;
    quoted: number;
    not_matching: number;
    need_human: number;
    priced: number;
    min_price: number | null;
    max_price: number | null;
    avg_price: number | null;
    meets_target: number;
    expected_price: number | null;
  };
}

export default function Compare() {
  const qc = useQueryClient();
  const [campaignId, setCampaignId] = useState<number | undefined>();
  const [product, setProduct] = useState('');
  const [range, setRange] = useState<[Dayjs, Dayjs] | null>(null);
  const [onlyPriced, setOnlyPriced] = useState(false);
  /* 页面默认保留"不做此款"的行（标注结论，能看到对方原话/原因）；
     导出 CSV 时后端会默认把这些行隐藏掉，见 repo.csv_rows。 */
  const [includeDropped, setIncludeDropped] = useState(true);
  const [viewMode, setViewMode] = useState<'detail' | 'concise'>('detail');

  const campaigns = useQuery({ queryKey: ['campaigns'], queryFn: () => get<{ items: Campaign[] }>('/api/campaigns', { include_archived: true }) });

  const params = useMemo(() => {
    const p: Record<string, unknown> = { limit: 1000 };
    if (campaignId) p.campaign_id = campaignId;
    if (product.trim()) p.product = product.trim();
    if (range) {
      p.from = range[0].format('YYYY-MM-DD');
      p.to = range[1].format('YYYY-MM-DD 23:59:59');
    }
    if (onlyPriced) p.only_priced = true;
    if (includeDropped) p.include_dropped = true;
    return p;
  }, [campaignId, product, range, onlyPriced, includeDropped]);

  const data = useQuery({
    queryKey: ['compare', params],
    queryFn: () => get<CompareResp>('/api/data/compare', params)
  });

  useEffect(() => {
    const h = () => void qc.invalidateQueries();
    window.addEventListener('ais:refresh', h);
    return () => window.removeEventListener('ais:refresh', h);
  }, [qc]);

  const exportQuery = useMemo(() => {
    const qs = new URLSearchParams();
    if (campaignId) qs.set('campaign_id', String(campaignId));
    if (product.trim()) qs.set('product', product.trim());
    if (range) {
      qs.set('from', range[0].format('YYYY-MM-DD'));
      qs.set('to', range[1].format('YYYY-MM-DD 23:59:59'));
    }
    if (onlyPriced) qs.set('only_priced', 'true');
    qs.set('include_dropped', includeDropped ? 'true' : 'false');
    return qs;
  }, [campaignId, product, range, onlyPriced, includeDropped]);

  const xlsxUrl = `/api/data/export/compare.xlsx?${exportQuery.toString()}`;
  const detailCsvUrl = useMemo(() => {
    const query = new URLSearchParams(exportQuery);
    query.set('mode', 'detail');
    return `/api/data/export/compare.csv?${query.toString()}`;
  }, [exportQuery]);
  const conciseCsvUrl = useMemo(() => {
    const query = new URLSearchParams(exportQuery);
    query.set('mode', 'concise');
    return `/api/data/export/compare.csv?${query.toString()}`;
  }, [exportQuery]);

  const s = data.data?.summary;

  const columns = [
    {
      title: '供应商 / 会话',
      width: 210,
      fixed: 'left' as const,
      render: (_: unknown, r: CompareRow) => (
        <Space direction="vertical" size={2}>
          <Typography.Text strong ellipsis style={{ maxWidth: 190 }}>
            {r.supplier_wangwang || '-'}
          </Typography.Text>
          <Typography.Text style={{ fontSize: 11, color: '#98a4b8' }} ellipsis>
            {r.conv_key || '-'}
          </Typography.Text>
        </Space>
      )
    },
    {
      title: '所属任务',
      dataIndex: 'campaign_name',
      width: 150,
      render: (v: string, r: CompareRow) => (v ? <Tag color="geekblue">{v}</Tag> : r.campaign_id ? `#${r.campaign_id}` : '-')
    },
    { title: '页面价', dataIndex: 'page_price_num', width: 90, render: (v: number) => (v == null ? '-' : fmtMoney(v, 4)) },
    {
      title: '商家回复原文',
      dataIndex: 'raw_text',
      width: 220,
      render: (v: string) => (
        <Typography.Text style={{ fontSize: 12.5 }} ellipsis={{ tooltip: v }}>
          {v || '-'}
        </Typography.Text>
      )
    },
    { title: '报价口径', dataIndex: 'price_basis', width: 116, render: (v: string) => <Tag>{basisLabel(v)}</Tag> },
    {
      title: '可比单价',
      dataIndex: 'unit_price_final',
      width: 104,
      sorter: (a: CompareRow, b: CompareRow) => (a.unit_price_final || 1e9) - (b.unit_price_final || 1e9),
      render: (v: number, r: CompareRow) => (
        <b style={{ color: r.verdict === '高于页面价' ? '#e5534b' : r.verdict === '低于页面价' ? '#18a058' : '#3b6fe0' }}>
          {v == null ? '-' : fmtMoney(v, 4)}
        </b>
      )
    },
    {
      title: '差价',
      dataIndex: 'diff',
      width: 96,
      render: (v: number, r: CompareRow) =>
        v == null ? (
          '-'
        ) : (
          <span style={{ color: v > 0 ? '#e5534b' : v < 0 ? '#18a058' : '#8b98ad' }}>
            {v > 0 ? '+' : ''}
            {fmtMoney(v, 4)}
            {r.diff_pct != null ? ` (${v > 0 ? '+' : ''}${r.diff_pct}%)` : ''}
          </span>
        )
    },
    {
      title: '结论',
      dataIndex: 'verdict',
      width: 148,
      filters: [
        { text: '低于页面价', value: '低于页面价' },
        { text: '与页面价持平', value: '与页面价持平' },
        { text: '高于页面价', value: '高于页面价' },
        { text: '不做此款', value: '不做此款' },
        { text: '需人工联系', value: '需人工联系' },
        { text: '信息不全', value: '信息不全' },
        { text: '无法比价', value: '无法比价' }
      ],
      onFilter: (v: unknown, r: CompareRow) => r.verdict === v,
      render: (v: string, r: CompareRow) => (
        <Space size={4}>
          <Tooltip
            title={
              r.verdict === '不做此款'
                ? `不做此款：${r.not_doing_reason || '对方表示做不了本品类'}`
                : r.verdict === '需人工联系'
                  ? `需人工联系：${r.handoff_contact || '对方只让找对接人'}`
                  : v
            }
          >
            <Tag color={verdictColor(v)}>{v}</Tag>
          </Tooltip>
          {r.meets_target === false ? <Tag color="red">超标</Tag> : r.meets_target === true ? <Tag color="green">达标</Tag> : null}
        </Space>
      )
    },
    { title: '起订量', dataIndex: 'moq', width: 96, render: (v: string) => v || '-' },
    { title: '运费', dataIndex: 'freight', width: 96, render: (v: string) => v || '-' },
    { title: '打样工期', dataIndex: 'sample_lead_time', width: 100, render: (v: string) => v || '-' },
    { title: '大货工期', dataIndex: 'bulk_lead_time', width: 100, render: (v: string) => v || '-' },
    { title: '打样费可退', dataIndex: 'sample_fee_refundable', width: 106, render: (v: string) => v || '-' },
    { title: '大货不退含样费价', dataIndex: 'price_incl_sample_fee', width: 130, render: (v: string) => v || '-' },
    { title: '次品率', dataIndex: 'defect_rate', width: 92, render: (v: string) => v || '-' },
    { title: '保密协议', dataIndex: 'nda', width: 96, render: (v: string) => v || '-' },
    {
      title: '备注',
      dataIndex: 'remark',
      width: 160,
      render: (v: string) => (
        <Typography.Text style={{ fontSize: 12 }} ellipsis={{ tooltip: v }}>
          {v || '-'}
        </Typography.Text>
      )
    },
    { title: '更新时间', dataIndex: 'updated_at', width: 150, render: (v: number) => fmtTime(v, false) }
  ];

  const summaryColumns = [
    {
      title: '供应商',
      width: 190,
      fixed: 'left' as const,
      render: (_: unknown, r: CompareRow) => (
        <Typography.Text strong ellipsis style={{ maxWidth: 170 }} title={r.supplier_wangwang || ''}>
          {r.supplier_wangwang || '-'}
        </Typography.Text>
      )
    },
    {
      title: '所属任务',
      dataIndex: 'campaign_name',
      width: 140,
      render: (v: string, r: CompareRow) => (v ? <Tag color="geekblue">{v}</Tag> : r.campaign_id ? `#${r.campaign_id}` : '-')
    },
    {
      title: '可比单价',
      dataIndex: 'unit_price_final',
      width: 100,
      sorter: (a: CompareRow, b: CompareRow) => (a.unit_price_final || 1e9) - (b.unit_price_final || 1e9),
      render: (v: number) => v == null ? '-' : fmtMoney(v, 4)
    },
    {
      title: '结论',
      dataIndex: 'verdict',
      width: 130,
      render: (v: string) => <Tag color={verdictColor(v)}>{v || '-'}</Tag>
    },
    ...[
      ['起订量', 'moq'],
      ['运费', 'freight'],
      ['打样工期', 'sample_lead_time'],
      ['大货工期', 'bulk_lead_time'],
      ['打样费可退', 'sample_fee_refundable'],
      ['大货不退含样费价', 'price_incl_sample_fee'],
      ['次品率', 'defect_rate'],
      ['保密协议', 'nda']
    ].map(([title, key]) => ({
      title,
      width: ['大货不退含样费价', '打样工期', '大货工期'].includes(title) ? 130 : 105,
      render: (_: unknown, row: CompareRow) => (
        <Typography.Text style={{ fontSize: 12 }} ellipsis={{ tooltip: String(row.summary_fields?.[key as keyof NonNullable<CompareRow['summary_fields']>] || '') }}>
          {String(row.summary_fields?.[key as keyof NonNullable<CompareRow['summary_fields']>] || '—')}
        </Typography.Text>
      )
    }))
  ];

  return (
    <Space direction="vertical" size={16} style={{ width: '100%' }}>
      <Row gutter={[16, 16]}>
        <Col xs={12} md={6} lg={4}>
          <StatCard
            icon={<span>条</span>}
            label="已询价"
            value={s?.quoted ?? '-'}
            color="#3b6fe0"
            hint={`含需人工联系 ${s?.need_human ?? 0} 家 ｜ 不做此款 ${s?.not_matching ?? 0} 家（不参与比价）｜ 不含名单占位行`}
          />
        </Col>
        <Col xs={12} md={6} lg={4}>
          <StatCard icon={<span>价</span>} label="可算出单价" value={s?.priced ?? '-'} color="#7a5af8" />
        </Col>
        <Col xs={12} md={6} lg={5}>
          <StatCard icon={<span>低</span>} label="最低可比单价" value={s?.min_price != null ? fmtMoney(s.min_price) : '-'} color="#18a058" />
        </Col>
        <Col xs={12} md={6} lg={5}>
          <StatCard icon={<span>高</span>} label="最高可比单价" value={s?.max_price != null ? fmtMoney(s.max_price) : '-'} color="#e5534b" />
        </Col>
        <Col xs={12} md={6} lg={6}>
          <StatCard
            icon={<span>标</span>}
            label="达标条数"
            value={s?.meets_target ?? 0}
            color="#17a2b8"
            hint={s?.expected_price != null ? `预期价格 ≤ ${fmtMoney(s.expected_price)}` : '未设置预期价格（可在参数设置里配置）'}
          />
        </Col>
      </Row>

      <Card
        title={
          <Space>
            <span>比价表</span>
            <Segmented
              size="small"
              value={viewMode}
              onChange={(value) => setViewMode(value as 'detail' | 'concise')}
              options={[
                { label: '详细', value: 'detail' },
                { label: '简洁', value: 'concise' }
              ]}
            />
          </Space>
        }
        extra={
          <Space wrap>
            <Select
              allowClear
              placeholder="按任务筛选"
              style={{ width: 200 }}
              value={campaignId}
              onChange={setCampaignId}
              options={(campaigns.data?.items || []).map((c) => ({ value: c.id, label: `#${c.id} ${c.name}` }))}
            />
            <Input.Search placeholder="商品 / 供应商关键词" allowClear style={{ width: 210 }} onSearch={setProduct} />
            <DatePicker.RangePicker value={range} onChange={(v) => setRange(v as [Dayjs, Dayjs] | null)} />
            <Tooltip title="只显示能算出可比单价的记录">
              <Space size={6}>
                <span style={{ fontSize: 12, color: '#5a6b85' }}>仅有价</span>
                <Switch size="small" checked={onlyPriced} onChange={setOnlyPriced} />
              </Space>
            </Tooltip>
            <Tooltip title="显示真实商家明确『不做此款』的记录（含补分析结果）；黑名单/名单占位行不会显示。导出 CSV 时默认隐藏这些行。">
              <Space size={6}>
                <span style={{ fontSize: 12, color: '#5a6b85' }}>显示不做此款</span>
                <Switch size="small" checked={includeDropped} onChange={setIncludeDropped} />
              </Space>
            </Tooltip>
            <Button icon={<ReloadOutlined />} onClick={() => void qc.invalidateQueries({ queryKey: ['compare'] })}>
              刷新
            </Button>
            <Tooltip title="Excel 文件包含「详细」「简洁」两个工作表；CSV 可按当前模式单独导出">
              <Dropdown
                menu={{
                  items: [
                    {
                      key: 'xlsx',
                      label: <a href={xlsxUrl}>Excel · 详细 + 简洁两个工作表</a>
                    },
                    { type: 'divider' },
                    {
                      key: 'csv-detail',
                      label: <a href={detailCsvUrl}>CSV · 详细</a>
                    },
                    {
                      key: 'csv-concise',
                      label: <a href={conciseCsvUrl}>CSV · 简洁</a>
                    }
                  ]
                }}
                trigger={['click']}
              >
                <Button type="primary" icon={<DownloadOutlined />}>
                  导出
                </Button>
              </Dropdown>
            </Tooltip>
          </Space>
        }
        styles={{ body: { padding: 12 } }}
      >
        <Typography.Text type="secondary" style={{ display: 'block', marginBottom: 8, fontSize: 12 }}>
          比价表只显示已产生回复/报价分析的商家；客户台账显示全部已联系客户。黑名单占位行不会出现在这里。
        </Typography.Text>
        <Table
          rowKey="id"
          size="middle"
          loading={data.isLoading}
          dataSource={data.data?.items || []}
          columns={viewMode === 'detail' ? columns : summaryColumns}
          scroll={{ x: viewMode === 'detail' ? 2230 : 1320 }}
          tableLayout="fixed"
          pagination={{ pageSize: 20, showSizeChanger: true, showTotal: (t) => `共 ${t} 条` }}
        />
      </Card>
    </Space>
  );
}
