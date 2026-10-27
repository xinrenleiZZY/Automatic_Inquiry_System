import { useEffect, useState } from 'react';
import {
  Alert,
  Button,
  Card,
  Form,
  Input,
  Modal,
  Popconfirm,
  Select,
  Space,
  Table,
  Tabs,
  Tag,
  Tooltip,
  Typography,
  message
} from 'antd';
import { PlusOutlined, StopOutlined, UndoOutlined } from '@ant-design/icons';
import { useQuery, useQueryClient } from '@tanstack/react-query';

import { del, detailOf, get, post } from '../api/client';
import type { Campaign, Customer, ListFlag } from '../api/types';
import { fmtTime } from '../utils/format';

const TYPES: Array<{ key: 'whitelist' | 'blacklist' | 'dropped'; label: string; hint: string }> = [
  { key: 'whitelist', label: '白名单', hint: '只对名单内的客户做自动追问（非空时生效）' },
  { key: 'blacklist', label: '黑名单', hint: '永不触达、永不自动回复' },
  { key: 'dropped', label: '放弃名单', hint: '人工终止追踪的客户' }
];

/* 名单的"适用范围"：0 = 全部任务（对所有任务生效）；任务 id = 只对该任务生效。
   同一家商家可以"任务一放弃、任务二照常跟进"——任务级名单会覆盖全局名单。 */
const SCOPE_ALL = 0;

export default function CustomerAdmin() {
  const qc = useQueryClient();
  const [form] = Form.useForm();
  const [open, setOpen] = useState(false);
  const [type, setType] = useState<'whitelist' | 'blacklist' | 'dropped'>('blacklist');
  const [scope, setScope] = useState<number>(SCOPE_ALL);

  const lists = useQuery({
    queryKey: ['settings-lists', scope],
    queryFn: () =>
      get<{ items: ListFlag[] }>('/api/settings/lists', scope ? { campaign_id: scope } : undefined)
  });
  const campaigns = useQuery({
    queryKey: ['campaigns'],
    queryFn: () => get<{ items: Campaign[] }>('/api/campaigns', { include_archived: true })
  });
  const customers = useQuery({
    queryKey: ['customers', ''],
    queryFn: () => get<{ items: Customer[] }>('/api/data/customers', { limit: 500 })
  });

  const scopeOptions = [
    { value: SCOPE_ALL, label: '全部任务（对所有任务生效）' },
    ...(campaigns.data?.items || []).map((c) => ({ value: c.id, label: `任务 ${c.id}：${c.name}` }))
  ];
  const scopeLabel = (id?: number | null) =>
    !id ? '全部' : (campaigns.data?.items.find((c) => c.id === id)?.name || `任务 ${id}`);

  useEffect(() => {
    const h = () => void qc.invalidateQueries();
    window.addEventListener('ais:refresh', h);
    return () => window.removeEventListener('ais:refresh', h);
  }, [qc]);

  const add = async (values: { conv_keys: string[]; note?: string; list_type: string; campaign_id?: number }) => {
    try {
      await post('/api/settings/lists', {
        ...values,
        list_type: type,
        campaign_id: values.campaign_id ?? scope
      });
      message.success('已加入名单');
      setOpen(false);
      form.resetFields();
      void qc.invalidateQueries({ queryKey: ['settings-lists'] });
      void qc.invalidateQueries({ queryKey: ['customers'] });
    } catch (e) {
      message.error(detailOf(e));
    }
  };

  const remove = async (key: string, campaignId = SCOPE_ALL) => {
    try {
      await del(`/api/settings/lists/${encodeURIComponent(key)}`, { campaign_id: campaignId });
      message.success('已移出名单');
      void qc.invalidateQueries({ queryKey: ['settings-lists'] });
      void qc.invalidateQueries({ queryKey: ['customers'] });
    } catch (e) {
      message.error(detailOf(e));
    }
  };

  const items = lists.data?.items || [];
  const columns = [
    {
      title: '客户',
      dataIndex: 'conv_name',
      width: 280,
      render: (v: string, r: ListFlag) => (
        <Space direction="vertical" size={2}>
          <Typography.Text strong>{v || '(未命名)'}</Typography.Text>
          <Typography.Text style={{ fontSize: 11, color: '#98a4b8' }}>{r.conv_key}</Typography.Text>
        </Space>
      )
    },
    { title: '类型', dataIndex: 'list_type', width: 110, render: (v: string) => <Tag color={v === 'whitelist' ? 'green' : v === 'blacklist' ? 'red' : 'default'}>{v}</Tag> },
    {
      title: '适用范围',
      dataIndex: 'campaign_id',
      width: 170,
      render: (v: number, r: ListFlag) =>
        v ? (
          <Tag color="blue">{scopeLabel(v)}</Tag>
        ) : (
          <Tooltip title="对所有任务生效">
            <Tag>全部任务</Tag>
          </Tooltip>
        )
    },
    { title: '备注', dataIndex: 'note', width: 170, render: (v: string) => v || '-' },
    { title: '更新时间', dataIndex: 'updated_at', width: 160, render: (v: number) => fmtTime(v, false) },
    {
      title: '操作',
      width: 120,
      render: (_: unknown, r: ListFlag) => (
        <Popconfirm
          title={`确认移出名单？（${r.campaign_id ? scopeLabel(r.campaign_id) : '全部任务'}）`}
          onConfirm={() => remove(r.conv_key, r.campaign_id || SCOPE_ALL)}
        >
          <Button size="small" icon={<UndoOutlined />}>
            移出
          </Button>
        </Popconfirm>
      )
    }
  ];

  return (
    <Space direction="vertical" size={16} style={{ width: '100%' }}>
      <Alert
        type="info"
        showIcon
        message="名单按「适用范围」生效"
        description={
          <>
            名单带任务维度：<b>全部任务</b> 的名单对所有任务生效；<b>某个任务</b> 的名单只影响该任务
            （任务级覆盖全局级，所以同一家商家可以"任务一放弃、任务二照常跟进"）。
            黑名单与放弃名单会在自动回复和联系商家两个环节被排除；白名单非空时只对名单内客户自动追问。
            修改立即生效，无需重启。
          </>
        }
      />

      <Card
        title="客户名单与追踪控制"
        extra={
          <Space>
            <Select
              value={scope}
              onChange={(v) => setScope(v)}
              style={{ width: 210 }}
              options={scopeOptions}
              loading={campaigns.isLoading}
            />
            <Button
              icon={<StopOutlined />}
              onClick={() => {
                setType('dropped');
                setOpen(true);
              }}
            >
              终止追踪
            </Button>
            <Button
              type="primary"
              icon={<PlusOutlined />}
              onClick={() => {
                setType('blacklist');
                setOpen(true);
              }}
            >
              加入名单
            </Button>
          </Space>
        }
        styles={{ body: { paddingTop: 8 } }}
      >
        <Tabs
          items={TYPES.map((t) => ({
            key: t.key,
            label: `${t.label}（${items.filter((i) => i.list_type === t.key).length}）`,
            children: (
              <>
                <Typography.Text style={{ fontSize: 12, color: '#8b98ad' }}>{t.hint}</Typography.Text>
                <Table
                  style={{ marginTop: 12 }}
                  rowKey={(r: ListFlag) => `${r.conv_key}#${r.campaign_id || 0}`}
                  size="middle"
                  loading={lists.isLoading}
                  dataSource={items.filter((i) => i.list_type === t.key)}
                  columns={columns}
                  scroll={{ x: 1000 }}
                  tableLayout="fixed"
                  pagination={{ pageSize: 10, showSizeChanger: false }}
                  locale={{ emptyText: `暂无${t.label}` }}
                />
              </>
            )
          }))}
        />
      </Card>

      <Modal
        open={open}
        title={type === 'dropped' ? '终止追踪（加入放弃名单）' : '加入名单'}
        onCancel={() => setOpen(false)}
        onOk={() => form.submit()}
        okText="保存"
        width={560}
      >
        <Form form={form} layout="vertical" onFinish={add} requiredMark={false}>
          <Form.Item name="list_type" label="名单类型" initialValue={type} key={type}>
            <Select
              value={type}
              onChange={(v) => setType(v)}
              options={TYPES.map((t) => ({ value: t.key, label: t.label }))}
            />
          </Form.Item>
          <Form.Item
            name="conv_keys"
            label="选择客户"
            rules={[{ required: true, message: '请选择或输入客户' }]}
            extra="可从台账里多选，也可以直接粘贴旺旺账号 / 会话号"
          >
            <Select
              mode="tags"
              placeholder="选择客户，或直接输入 conv_key / 旺旺号后回车"
              optionFilterProp="label"
              options={(customers.data?.items || []).map((c) => ({
                value: c.conv_key,
                label: `${c.name}（${c.conv_key.slice(0, 26)}…）`
              }))}
            />
          </Form.Item>
          <Form.Item name="note" label="备注">
            <Input.TextArea rows={2} placeholder="例如：报价虚高 / 不做该产品 / 已被人跟" />
          </Form.Item>
          <Form.Item
            name="campaign_id"
            label="适用范围"
            initialValue={scope}
            key={`scope-${scope}`}
            extra="选「全部任务」= 对所有任务生效；选某个任务 = 只对这个任务生效（同一家可以做任务二）"
          >
            <Select options={scopeOptions} />
          </Form.Item>
        </Form>
      </Modal>
    </Space>
  );
}
