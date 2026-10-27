import { useEffect, useState } from 'react';
import { Alert, Button, Card, Form, Image, Input, Modal, Popconfirm, Select, Space, Table, Tag, Typography, message } from 'antd';
import { DeleteOutlined, EditOutlined, PlusOutlined } from '@ant-design/icons';
import { useQuery, useQueryClient } from '@tanstack/react-query';

import { del, detailOf, get, post, put } from '../api/client';
import type { LibraryImage, Phrase } from '../api/types';

const imgUrl = (p?: string) => (p ? `/api/library/file?path=${encodeURIComponent(p)}` : '');

export default function Phrases() {
  const qc = useQueryClient();
  const [form] = Form.useForm();
  const [open, setOpen] = useState(false);
  const [editing, setEditing] = useState<Phrase | null>(null);

  const phrases = useQuery({ queryKey: ['phrases'], queryFn: () => get<{ items: Phrase[]; total: number }>('/api/phrases') });
  const images = useQuery({
    queryKey: ['library-images'],
    queryFn: () => get<{ items: LibraryImage[] }>('/api/library/images')
  });

  useEffect(() => {
    const h = () => void qc.invalidateQueries();
    window.addEventListener('ais:refresh', h);
    return () => window.removeEventListener('ais:refresh', h);
  }, [qc]);

  const refresh = () => {
    void qc.invalidateQueries({ queryKey: ['phrases'] });
  };

  const openNew = () => {
    setEditing(null);
    form.resetFields();
    setOpen(true);
  };

  const openEdit = (p: Phrase) => {
    setEditing(p);
    form.setFieldsValue({ ...p, tags: p.tags || [] });
    setOpen(true);
  };

  const submit = async (values: {
    id?: string;
    name: string;
    text: string;
    image?: string;
    keyword?: string;
    tags?: string[];
  }) => {
    try {
      if (editing) {
        await put(`/api/phrases/${encodeURIComponent(editing.id)}`, {
          name: values.name,
          text: values.text,
          image: values.image || '',
          keyword: (values.keyword || '').trim(),
          tags: values.tags || []
        });
        message.success('已保存');
      } else {
        await post('/api/phrases', {
          ...values,
          keyword: (values.keyword || '').trim(),
          tags: values.tags || []
        });
        message.success('已新增');
      }
      setOpen(false);
      refresh();
    } catch (e) {
      message.error(detailOf(e));
    }
  };

  const remove = async (id: string) => {
    try {
      await del(`/api/phrases/${encodeURIComponent(id)}`);
      message.success('已删除');
      refresh();
    } catch (e) {
      message.error(detailOf(e));
    }
  };

  const columns = [
    {
      title: '图片',
      dataIndex: 'image',
      width: 92,
      render: (v: string) =>
        v ? (
          <Image src={imgUrl(v)} width={52} height={52} style={{ objectFit: 'cover', borderRadius: 8 }} />
        ) : (
          <div style={{ width: 52, height: 52, borderRadius: 8, background: '#f2f4f8', display: 'grid', placeItems: 'center', color: '#b6c0d0', fontSize: 11 }}>
            纯文字
          </div>
        )
    },
    {
      title: '名称 / ID',
      width: 200,
      render: (_: unknown, r: Phrase) => (
        <Space direction="vertical" size={2}>
          <Typography.Text strong>{r.name}</Typography.Text>
          <Typography.Text style={{ fontSize: 11, color: '#98a4b8' }}>{r.id}</Typography.Text>
        </Space>
      )
    },
    {
      title: '产品关键词',
      dataIndex: 'keyword',
      width: 140,
      render: (v: string) =>
        v ? (
          <Tag color="blue" style={{ maxWidth: 132, overflow: 'hidden', textOverflow: 'ellipsis' }}>
            {v}
          </Tag>
        ) : (
          '-'
        )
    },
    {
      title: '话术内容',
      dataIndex: 'text',
      width: 280,
      render: (v: string) => (
        <Typography.Text style={{ fontSize: 13 }} ellipsis={{ tooltip: v }}>
          {v || '-'}
        </Typography.Text>
      )
    },
    {
      title: '标签',
      dataIndex: 'tags',
      width: 140,
      render: (v: string[]) => (v?.length ? v.map((t) => <Tag key={t}>{t}</Tag>) : '-')
    },
    {
      title: '状态',
      dataIndex: 'enabled',
      width: 80,
      render: (v: boolean) => <Tag color={v === false ? 'default' : 'green'}>{v === false ? '停用' : '启用'}</Tag>
    },
    {
      title: '操作',
      width: 120,
      render: (_: unknown, r: Phrase) => (
        <Space>
          <Button size="small" icon={<EditOutlined />} onClick={() => openEdit(r)}>
            编辑
          </Button>
          <Popconfirm title="确认删除该短语？" onConfirm={() => remove(r.id)}>
            <Button size="small" danger icon={<DeleteOutlined />} />
          </Popconfirm>
        </Space>
      )
    }
  ];

  return (
    <Space direction="vertical" size={16} style={{ width: '100%' }}>
      <Alert
        type="info"
        showIcon
        message="一条短语 = 一段文字 + 一张图 + 可选产品关键词"
        description="产品关键词（如纸杯、鼠标垫）会在任务搜图后自动填入 1688 的「结果中搜索」；联系前还会用 AI 按商品名称审核是否同品类，不符合的自动跳过。留空关键词则只按图片搜索。聊天框的贴图是「点了就发」，所以图文短语会作为两条消息发出（默认先文字后图片）。"
      />

      <Card
        title={`快捷短语库（${phrases.data?.total ?? 0}）`}
        extra={
          <Button type="primary" icon={<PlusOutlined />} onClick={openNew}>
            新增短语
          </Button>
        }
        styles={{ body: { padding: 12 } }}
      >
        <Table
          rowKey="id"
          size="middle"
          loading={phrases.isLoading}
          dataSource={phrases.data?.items || []}
          columns={columns}
          pagination={false}
          scroll={{ x: 1052 }}
          tableLayout="fixed"
          locale={{ emptyText: '暂无短语，点右上角新增' }}
        />
      </Card>

      <Modal
        open={open}
        title={editing ? `编辑短语 · ${editing.name}` : '新增快捷短语'}
        onCancel={() => setOpen(false)}
        onOk={() => form.submit()}
        okText="保存"
        width={560}
      >
        <Form form={form} layout="vertical" onFinish={submit} requiredMark={false}>
          {!editing ? (
            <Form.Item name="id" label="短语 ID" tooltip="留空会自动生成，例如 ask-custom-price">
              <Input placeholder="留空自动生成" />
            </Form.Item>
          ) : null}
          <Form.Item name="name" label="名称" rules={[{ required: true, message: '请输入名称' }]}>
            <Input placeholder="例如：询价：定制价格" />
          </Form.Item>
          <Form.Item name="text" label="话术内容">
            <Input.TextArea rows={3} placeholder="例如：这个定制什么价格？麻烦报含税单价和起订量，谢谢" />
          </Form.Item>
          <Form.Item
            name="keyword"
            label="产品关键词"
            tooltip="搜图进入结果页后，会自动填入 1688「结果中搜索」并再搜索一次；填纸杯、鼠标垫这类词可以让客户更精准"
          >
            <Input placeholder="例如：纸杯 / 鼠标垫（留空则只按图片搜索）" />
          </Form.Item>
          <Form.Item name="image" label="配图" tooltip="留空表示纯文字短语">
            <Select
              allowClear
              placeholder="从图片库选择"
              showSearch
              options={(images.data?.items || []).map((i) => ({ value: i.path, label: i.fileName }))}
            />
          </Form.Item>
          <Form.Item name="tags" label="标签">
            <Select mode="tags" placeholder="输入后回车，例如：询价 / 羽毛笔" />
          </Form.Item>
        </Form>
      </Modal>
    </Space>
  );
}
