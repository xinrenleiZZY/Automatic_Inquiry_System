import { useState } from 'react';
import {
  Alert,
  Button,
  Card,
  Col,
  Form,
  Input,
  InputNumber,
  Modal,
  Popconfirm,
  Row,
  Select,
  Space,
  Table,
  Tag,
  Typography,
  message
} from 'antd';
import { DeleteOutlined, EditOutlined, PlusOutlined } from '@ant-design/icons';
import { useQuery, useQueryClient } from '@tanstack/react-query';

import { del, detailOf, get, post, put } from '../api/client';
import type { PricingTemplate } from '../api/types';
import { useAuth } from '../auth/AuthContext';
import { fmtTime } from '../utils/format';

const MODE: Record<string, { label: string; color: string }> = {
  send: { label: '真实发送', color: 'red' },
  draft: { label: '只填草稿', color: 'blue' },
  dry: { label: '只解析不发送', color: 'default' }
};

type TemplateForm = {
  name: string;
  description?: string;
  send_mode: 'send' | 'draft' | 'dry';
  inquiry_count: number;
  slice_per_round: number;
  expected_price?: number | null;
  expected_price_note?: string;
  max_followups: number;
  duration_min: number;
  reply_timeout_sec: number;
};

const durationLabel = (seconds?: number) => {
  const value = Number(seconds || 0);
  if (!value) return '不限时';
  if (value % 60 === 0) return `${value / 60} 分钟`;
  return `${value} 秒`;
};

export default function PricingTemplates() {
  const qc = useQueryClient();
  const { user } = useAuth();
  const canManage = !!user?.roles.some((role) => role === 'admin' || role === 'gm');
  const [open, setOpen] = useState(false);
  const [editing, setEditing] = useState<PricingTemplate | null>(null);
  const [saving, setSaving] = useState(false);
  const [form] = Form.useForm<TemplateForm>();

  const templates = useQuery({
    queryKey: ['pricing-templates'],
    queryFn: () => get<{ items: PricingTemplate[]; total: number; max: number }>('/api/pricing-templates')
  });

  const refresh = () => void qc.invalidateQueries({ queryKey: ['pricing-templates'] });

  const openCreate = () => {
    setEditing(null);
    form.resetFields();
    form.setFieldsValue({
      send_mode: 'send',
      inquiry_count: 10,
      slice_per_round: 2,
      expected_price: undefined,
      expected_price_note: '',
      max_followups: 2,
      duration_min: 0,
      reply_timeout_sec: 60
    });
    setOpen(true);
  };

  const openEdit = (item: PricingTemplate) => {
    setEditing(item);
    form.setFieldsValue({
      name: item.name,
      description: item.description,
      send_mode: item.send_mode,
      inquiry_count: item.inquiry_count,
      slice_per_round: item.slice_per_round,
      expected_price: item.expected_price,
      expected_price_note: item.expected_price_note,
      max_followups: item.max_followups,
      duration_min: Math.round((item.duration_sec || 0) / 60),
      reply_timeout_sec: item.reply_timeout_sec
    });
    setOpen(true);
  };

  const save = async (values: TemplateForm) => {
    setSaving(true);
    try {
      const payload = {
        name: values.name,
        description: values.description,
        send_mode: values.send_mode,
        inquiry_count: values.inquiry_count,
        slice_per_round: values.slice_per_round,
        expected_price: values.expected_price,
        expected_price_note: values.expected_price_note,
        max_followups: values.max_followups,
        duration_sec: Math.round(Number(values.duration_min || 0) * 60),
        reply_timeout_sec: values.reply_timeout_sec
      };
      if (editing) {
        await put(`/api/pricing-templates/${editing.id}`, payload);
        message.success('配置方案已更新');
      } else {
        await post('/api/pricing-templates', payload);
        message.success('配置方案已创建');
      }
      setOpen(false);
      form.resetFields();
      refresh();
    } catch (e) {
      message.error(detailOf(e));
    } finally {
      setSaving(false);
    }
  };

  const remove = async (item: PricingTemplate) => {
    try {
      await del(`/api/pricing-templates/${item.id}`);
      message.success('配置方案已删除');
      refresh();
    } catch (e) {
      message.error(detailOf(e));
    }
  };

  const total = templates.data?.total || 0;
  const max = templates.data?.max || 100;
  const atLimit = total >= max;

  return (
    <Space direction="vertical" size={16} style={{ width: '100%' }}>
      <Alert
        type="info"
        showIcon
        message="比价配置方案用于一键套用到新建任务"
        description="每套方案包含发送模式、询价客户数量、同时处理会话数、预期价格要求，以及超时追问、任务最长运行和每客户超时判定。新建任务时选择方案即可自动填入任务级参数，之后仍可手动调整。"
      />

      <Card
        title={`配置方案（${total} / ${max}）`}
        extra={(
          <Button
            type="primary"
            icon={<PlusOutlined />}
            disabled={!canManage || atLimit}
            onClick={openCreate}
          >
            新建方案
          </Button>
        )}
      >
        <Table
          rowKey="id"
          size="middle"
          loading={templates.isLoading}
          dataSource={templates.data?.items || []}
          pagination={{ pageSize: 10, showSizeChanger: false }}
          scroll={{ x: 1500 }}
          locale={{ emptyText: '还没有配置方案。新建一套后，可在创建任务时一键套用。' }}
          columns={[
            {
              title: '方案名称',
              dataIndex: 'name',
              width: 220,
              render: (value: string, item: PricingTemplate) => (
                <Space direction="vertical" size={2}>
                  <Typography.Text strong>{value}</Typography.Text>
                  <Typography.Text type="secondary" style={{ fontSize: 12 }}>
                    {item.description || '无说明'}
                  </Typography.Text>
                </Space>
              )
            },
            {
              title: '发送模式',
              dataIndex: 'send_mode',
              width: 130,
              render: (value: string) => (
                <Tag color={MODE[value]?.color}>{MODE[value]?.label || value}</Tag>
              )
            },
            {
              title: '询价客户',
              dataIndex: 'inquiry_count',
              width: 100,
              render: (value: number) => `${value} 家`
            },
            {
              title: '同时处理会话',
              dataIndex: 'slice_per_round',
              width: 130,
              render: (value: number) => `${value} 个`
            },
            {
              title: '预期单价上限',
              dataIndex: 'expected_price',
              width: 130,
              render: (value: number | null) => value == null ? '未设置' : `¥ ${value}`
            },
            {
              title: '预期价格说明',
              dataIndex: 'expected_price_note',
              width: 220,
              ellipsis: true,
              render: (value: string) => value || '-'
            },
            {
              title: '超时追问',
              dataIndex: 'max_followups',
              width: 100,
              render: (value: number) => `${value} 次`
            },
            {
              title: '最长运行',
              dataIndex: 'duration_sec',
              width: 110,
              render: (value: number) => durationLabel(value)
            },
            {
              title: '客户超时',
              dataIndex: 'reply_timeout_sec',
              width: 110,
              render: (value: number) => `${value} 秒`
            },
            {
              title: '更新时间',
              dataIndex: 'updated_at',
              width: 150,
              render: (value: number) => fmtTime(value, false)
            },
            {
              title: '操作',
              width: 130,
              fixed: 'right',
              render: (_: unknown, item: PricingTemplate) => (
                <Space size={4}>
                  <Button
                    size="small"
                    type="link"
                    icon={<EditOutlined />}
                    disabled={!canManage}
                    onClick={() => openEdit(item)}
                  >
                    编辑
                  </Button>
                  <Popconfirm
                    title="删除这套配置方案？"
                    description="只删除方案模板，不影响已经创建的任务。"
                    okText="删除"
                    cancelText="取消"
                    onConfirm={() => remove(item)}
                  >
                    <Button size="small" type="link" danger disabled={!canManage} icon={<DeleteOutlined />}>
                      删除
                    </Button>
                  </Popconfirm>
                </Space>
              )
            }
          ]}
        />
      </Card>

      <Modal
        open={open}
        title={editing ? `编辑配置方案：${editing.name}` : '新建比价配置方案'}
        width={720}
        okText={editing ? '保存' : '创建'}
        cancelText="取消"
        confirmLoading={saving}
        onOk={() => form.submit()}
        onCancel={() => {
          setOpen(false);
          form.resetFields();
        }}
      >
        <Form form={form} layout="vertical" onFinish={save} requiredMark={false}>
          <Form.Item
            name="name"
            label="方案名称"
            rules={[{ required: true, whitespace: true, message: '请输入方案名称' }]}
          >
            <Input maxLength={80} showCount placeholder="例如：400 套定制鼠标垫报价" />
          </Form.Item>
          <Form.Item name="description" label="方案说明">
            <Input.TextArea rows={2} maxLength={500} showCount placeholder="说明适用产品、订单量或谈判策略" />
          </Form.Item>
          <Row gutter={16}>
            <Col span={8}>
              <Form.Item name="send_mode" label="发送模式" rules={[{ required: true }]}>
                <Select
                  options={[
                    { value: 'send', label: 'send · 真实发送' },
                    { value: 'draft', label: 'draft · 只填草稿' },
                    { value: 'dry', label: 'dry · 只解析不发送' }
                  ]}
                />
              </Form.Item>
            </Col>
            <Col span={8}>
              <Form.Item name="inquiry_count" label="询价客户数量" rules={[{ required: true }]}>
                <InputNumber min={0} max={500} precision={0} style={{ width: '100%' }} addonAfter="家" />
              </Form.Item>
            </Col>
            <Col span={8}>
              <Form.Item name="slice_per_round" label="同时处理会话数" rules={[{ required: true }]}>
                <InputNumber min={1} max={50} precision={0} style={{ width: '100%' }} addonAfter="个" />
              </Form.Item>
            </Col>
          </Row>
          <Row gutter={16}>
            <Col span={8}>
              <Form.Item
                name="expected_price"
                label="预期单价上限"
                extra="选填；留空时任务沿用全局预期单价"
              >
                <InputNumber min={0} precision={2} style={{ width: '100%' }} addonBefore="¥" />
              </Form.Item>
            </Col>
            <Col span={16}>
              <Form.Item name="expected_price_note" label="预期价格说明">
                <Input maxLength={500} placeholder="例如：含税含运，400 套起订，单价不得超过 8 元" />
              </Form.Item>
            </Col>
          </Row>
          <Row gutter={16}>
            <Col span={8}>
              <Form.Item
                name="max_followups"
                label="超时后最多主动追问"
                rules={[{ required: true }]}
              >
                <InputNumber min={0} max={2} precision={0} style={{ width: '100%' }} addonAfter="次" />
              </Form.Item>
            </Col>
            <Col span={8}>
              <Form.Item
                name="duration_min"
                label="任务最长运行时长"
                rules={[{ required: true }]}
                extra="0 表示不按时间自动结束"
              >
                <InputNumber min={0} max={1440} precision={0} style={{ width: '100%' }} addonAfter="分钟" />
              </Form.Item>
            </Col>
            <Col span={8}>
              <Form.Item
                name="reply_timeout_sec"
                label="每客户超时判定"
                rules={[{ required: true }]}
              >
                <InputNumber min={1} max={86400} precision={0} style={{ width: '100%' }} addonAfter="秒" />
              </Form.Item>
            </Col>
          </Row>
        </Form>
      </Modal>
    </Space>
  );
}
