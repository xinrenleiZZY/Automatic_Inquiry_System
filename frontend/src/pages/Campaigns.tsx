import { useEffect, useState } from 'react';
import {
  Alert,
  Button,
  Card,
  Collapse,
  Col,
  Divider,
  Dropdown,
  Form,
  InputNumber,
  Image,
  Input,
  Modal,
  Popconfirm,
  Progress,
  Switch,
  Row,
  Select,
  Space,
  Table,
  Tag,
  Tooltip,
  Typography,
  message
} from 'antd';
import {
  CaretRightOutlined,
  DownloadOutlined,
  EyeOutlined,
  InboxOutlined,
  MoreOutlined,
  PauseCircleOutlined,
  PlayCircleOutlined,
  PlusOutlined,
  RedoOutlined,
  ReloadOutlined,
  RobotOutlined,
  RocketOutlined,
  SendOutlined,
  SyncOutlined,
  ThunderboltOutlined
} from '@ant-design/icons';
import { useQuery, useQueryClient } from '@tanstack/react-query';

import { del, detailOf, get, post, put } from '../api/client';
import type { Campaign, Job, LibraryImage, Phrase, PricingTemplate, Settings } from '../api/types';
import { fmtTime, stageLabel, statusLabel } from '../utils/format';
import { useJobRunner } from '../components/JobRunner';

const imgUrl = (p?: string | null) => (p ? `/api/library/file?path=${encodeURIComponent(p)}` : '');

export default function Campaigns() {
  const qc = useQueryClient();
  const [form] = Form.useForm();
  const [open, setOpen] = useState(false);
  const [detail, setDetail] = useState<Campaign | null>(null);
  const [autoOpen, setAutoOpen] = useState(false);
  const [autoCampaign, setAutoCampaign] = useState<Campaign | null>(null);
  const [autoMode, setAutoMode] = useState<'auto' | 'full'>('auto');
  const [autoForm] = Form.useForm();
  /* 任务列表默认隐藏已归档（归档 = 任务结束，只读留档）；勾上才显示 */
  const [showArchived, setShowArchived] = useState(false);
  const runner = useJobRunner();

  const campaigns = useQuery({
    queryKey: ['campaigns', showArchived],
    queryFn: () => get<{ items: Campaign[] }>('/api/campaigns', { include_archived: showArchived }),
    refetchInterval: 8000
  });
  const phrases = useQuery({ queryKey: ['phrases'], queryFn: () => get<{ items: Phrase[] }>('/api/phrases') });
  const pricingTemplates = useQuery({
    queryKey: ['pricing-templates'],
    queryFn: () => get<{ items: PricingTemplate[]; total: number; max: number }>('/api/pricing-templates')
  });
  const images = useQuery({
    queryKey: ['library-images'],
    queryFn: () => get<{ items: LibraryImage[] }>('/api/library/images')
  });
  const settings = useQuery({ queryKey: ['settings'], queryFn: () => get<{ settings: Settings }>('/api/settings') });
  const formImage = Form.useWatch('image', form);
  const selectedTemplateId = Form.useWatch('template_id', form);
  const selectedTemplate = (pricingTemplates.data?.items || []).find(
    (item) => item.id === selectedTemplateId
  );
  const autoTemplateId = Form.useWatch('template_id', autoForm);
  const autoTemplate = (pricingTemplates.data?.items || []).find(
    (item) => item.id === autoTemplateId
  );

  const applyTemplate = (templateId?: number) => {
    const template = (pricingTemplates.data?.items || []).find((item) => item.id === templateId);
    form.setFieldValue('params', template ? {
      send_mode: template.send_mode,
      inquiry_count: template.inquiry_count,
      slice_per_round: template.slice_per_round,
      expected_price: template.expected_price,
      expected_price_note: template.expected_price_note || '',
      max_followups: template.max_followups,
      duration_sec: template.duration_sec,
      reply_timeout_sec: template.reply_timeout_sec
    } : undefined);
  };
  /* 选中带配图的快捷短语时，产品图片直接用它的配图；也可手动选图覆盖 */
  const onPhraseChange = (phraseId?: string) => {
    const phrase = (phrases.data?.items || []).find((p) => p.id === phraseId);
    if (phrase?.image) {
      const norm = (v: string) => v.replace(/\\/g, '/').toLowerCase();
      const phraseImage = norm(phrase.image);
      const file = phraseImage.split('/').pop();
      /* 短语库里可能存相对路径，统一映射成图片库里同名的绝对路径，下拉框才能正常回显 */
      const libImage = (images.data?.items || []).find((i) => {
        const p = norm(i.path);
        return p === phraseImage || p.endsWith('/' + phraseImage) || norm(i.fileName) === file;
      });
      form.setFieldValue('image', libImage?.path || phrase.image);
      void form.validateFields(['image']).catch(() => undefined);
    }
  };

  useEffect(() => {
    const h = () => void qc.invalidateQueries();
    window.addEventListener('ais:refresh', h);
    return () => window.removeEventListener('ais:refresh', h);
  }, [qc]);

  const doJob = async (fn: () => Promise<{ job: Job }>, label: string) => {
    try {
      const { job } = await fn();
      message.info(`${label}已进入队列`);
      runner.start(job.id);
    } catch (e) {
      message.error(detailOf(e));
    }
  };

  const launch = (c: Campaign) =>
    Modal.confirm({
      title: `启动任务《${c.name}》`,
      content: (
        <div style={{ fontSize: 13, lineHeight: 1.9 }}>
          将按参数设置里的「询价客户数量」= <b>{settings.data?.settings.inquiry_count ?? 10}</b> 家执行：
          <br />
          ① 以图搜图（带产品关键词）→ ② <b>AI 按商品名称审核是否同品类，不符合跳过</b>
          → ③ 逐个打开符合项会话并 <b style={{ color: '#e5534b' }}>真实发送询价短语 + 图片</b>
          <br />
          <span style={{ color: '#8b98ad' }}>这是真实对外发送，商家会收到消息。</span>
        </div>
      ),
      okText: '确认执行',
      okButtonProps: { danger: true },
      cancelText: '取消',
      onOk: () => doJob(() => post<{ job: Job }>(`/api/campaigns/${c.id}/launch`, { yes: true }), '启动')
    });

  const collect = (c: Campaign) =>
    doJob(() => post<{ job: Job }>(`/api/campaigns/${c.id}/collect`, {}), '采集');
  const advance = (c: Campaign) => doJob(() => post<{ job: Job }>(`/api/campaigns/${c.id}/advance`, {}), '推进');
  /* 补分析：拿库里的入站文本补调一次 DeepSeek，判「做不了」就落放弃、停止追问 */
  const audit = (c: Campaign) =>
    doJob(() => post<{ job: Job }>(`/api/campaigns/${c.id}/audit-replies`, { limit: 200 }), '补分析');
  const resend = (c: Campaign) =>
    doJob(() => post<{ job: Job }>(`/api/campaigns/${c.id}/resend`, {}), '补发询价短语');
  const confirmResend = (c: Campaign) =>
    Modal.confirm({
      title: `补发任务《${c.name}》的询价短语？`,
      content: '只补发给「已联系但短语未发全」的商家，会真实发送文字和图片。',
      okText: '确认补发',
      okButtonProps: { danger: true },
      cancelText: '取消',
      onOk: () => resend(c)
    });

  const openAuto = (c: Campaign, mode: 'auto' | 'full' = 'auto') => {
    const effective = c.params_effective || {};
    setAutoMode(mode);
    setAutoCampaign(c);
    autoForm.setFieldsValue({
      template_id: undefined,
      mode: undefined,
      duration_min: Math.round((Number(effective.duration_sec || 0) / 60) * 100) / 100,
      timeout_sec: Number(effective.reply_timeout_sec || 60),
      max_followups: Number(effective.max_followups ?? 2),
      followup_text: '',
      ensure_sent: true,
      stop_when_complete: true,
      send_table: false,
      table_target: '',
      // 全自动比价专用
      limit: mode === 'full' ? Number(effective.inquiry_count ?? settings.data?.settings.inquiry_count ?? 10) : undefined,
      send_feishu: true,
      feishu_file: true,
      feishu_chat_id: ''
    });
    setAutoOpen(true);
  };

  const applyAutoTemplate = (templateId?: number) => {
    const template = (pricingTemplates.data?.items || []).find((item) => item.id === templateId);
    if (!template) {
      if (autoCampaign) openAuto(autoCampaign, autoMode);
      return;
    }
    autoForm.setFieldsValue({
      limit: template.inquiry_count,
      mode: template.send_mode,
      max_followups: template.max_followups,
      duration_min: Math.round((Number(template.duration_sec || 0) / 60) * 100) / 100,
      timeout_sec: template.reply_timeout_sec
    });
  };

  const submitAuto = async (values: Record<string, unknown>) => {
    if (!autoCampaign) return;
    const common = {
      template_id: values.template_id ?? null,
      mode: values.mode || null,
      duration_sec: Math.round(Number(values.duration_min || 0) * 60),
      wait_sec: 0,
      reply_timeout_sec: values.timeout_sec ?? 60,
      max_followups: Math.min(2, Number(values.max_followups ?? 2)),
      slice: null,
      followup_text: values.followup_text || '',
      ensure_sent: !!values.ensure_sent,
      stop_when_complete: true,
      send_table: !!values.send_table,
      table_target: values.table_target || ''
    };
    try {
      const { job } =
        autoMode === 'full'
          ? await post<{ job: Job }>(`/api/campaigns/${autoCampaign.id}/fullauto`, {
              ...common,
              limit: values.limit ?? null,
              yes: true,
              send_feishu: !!values.send_feishu,
              feishu_file: !!values.feishu_file,
              feishu_chat_id: values.feishu_chat_id || ''
            })
          : await post<{ job: Job }>(`/api/campaigns/${autoCampaign.id}/autocollect`, common);
      message.info(autoMode === 'full' ? '全自动比价已进入队列' : '自动采集已进入队列');
      setAutoOpen(false);
      runner.start(job.id);
      void qc.invalidateQueries({ queryKey: ['campaigns'] });
    } catch (e) {
      message.error(detailOf(e));
    }
  };

  const pushFeishu = async (c: Campaign) => {
    try {
      const r = await post<{ ok?: boolean; card_sent?: boolean; file_sent?: boolean | null; error?: string }>(
        `/api/campaigns/${c.id}/feishu`,
        { send_file: true }
      );
      if (r.ok) message.success('已推送飞书：比价表总结 + 比价表文件');
      else message.warning(`飞书未发出：${r.error || '未配置或发送失败'}`);
    } catch (e) {
      message.error(detailOf(e));
    }
  };

  const toggle = async (c: Campaign) => {
    const next = c.status === 'running' ? 'paused' : 'running';
    try {
      await put(`/api/campaigns/${c.id}`, { status: next });
      message.success(next === 'running' ? '已恢复' : '已暂停');
      void qc.invalidateQueries({ queryKey: ['campaigns'] });
    } catch (e) {
      message.error(detailOf(e));
    }
  };

  const archive = async (c: Campaign) => {
    try {
      const r = await del<{ csv_name?: string; csv_error?: string }>(`/api/campaigns/${c.id}`);
      message.success(
        r?.csv_name ? `已归档，最终比价表已导出：${r.csv_name}` : '已归档（比价表导出失败，可在比价表页手动导出）'
      );
      void qc.invalidateQueries({ queryKey: ['campaigns'] });
    } catch (e) {
      message.error(detailOf(e));
    }
  };

  /* 取消归档：回到「已暂停」，不会自动开跑 */
  const unarchive = async (c: Campaign) => {
    try {
      await post(`/api/campaigns/${c.id}/unarchive`, {});
      message.success('已取消归档（状态：已暂停）');
      void qc.invalidateQueries({ queryKey: ['campaigns'] });
    } catch (e) {
      message.error(detailOf(e));
    }
  };

  const openDetail = async (c: Campaign) => {
    try {
      setDetail(await get<Campaign>(`/api/campaigns/${c.id}`));
    } catch (e) {
      message.error(detailOf(e));
    }
  };

  const create = async (values: Record<string, unknown>) => {
    // 只把"真的填了"的业务参数发给后端；留空的字段不提交 = 用全局默认
    const rawParams = (values.params || {}) as Record<string, unknown>;
    const params: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(rawParams)) {
      if (v !== undefined && v !== null && v !== '') params[k] = v;
    }
    try {
      await post('/api/campaigns', {
        name: values.name,
        image: values.image,
        phrase_id: values.phrase_id ?? undefined,
        note: values.note ?? '',
        params,
        template_id: values.template_id ?? undefined
      });
      const n = Object.keys(params).length;
      message.success(
        values.template_id
          ? `任务已创建，已套用「${selectedTemplate?.name || `方案 ${values.template_id}`}」`
          : n
            ? `任务已创建（自定义了 ${n} 项业务参数）`
            : '任务已创建（业务参数沿用全局默认）'
      );
      setOpen(false);
      form.resetFields();
      void qc.invalidateQueries({ queryKey: ['campaigns'] });
    } catch (e) {
      message.error(detailOf(e));
    }
  };

  const refreshTabs = async () => {
    try {
      const r = await post<{ summary?: unknown }>('/api/flows/tabs/enforce', {});
      message.success('标签页已收敛：' + JSON.stringify(r?.summary || {}));
    } catch (e) {
      message.error(detailOf(e));
    }
  };

  const refreshPages = () =>
    doJob(() => post<{ job: Job }>('/api/flows/refresh', {}), '聊天页刷新');

  const columns = [
    { title: '#', dataIndex: 'id', width: 56 },
    {
      title: '产品图',
      dataIndex: 'image_file',
      width: 74,
      render: (v: string) => (v ? <Image src={imgUrl(v)} width={44} height={44} style={{ objectFit: 'cover', borderRadius: 8 }} /> : '-')
    },
    {
      title: '任务 / 短语',
      width: 260,
      render: (_: unknown, r: Campaign) => (
        <Space direction="vertical" size={2}>
          <Space size={6}>
            <Typography.Text strong>{r.name}</Typography.Text>
            {r.params_customized ? (
              <Tooltip title="该任务自定义了业务参数，未覆盖的项仍用全局默认">
                <Tag color="purple" style={{ marginInlineEnd: 0 }}>
                  自定义参数
                </Tag>
              </Tooltip>
            ) : null}
          </Space>
          <Typography.Text style={{ fontSize: 12, color: '#8b98ad' }} ellipsis>
            {r.phrase_id ? `短语：${r.phrase_id}` : '未绑定短语'} · imageId {r.image_id || '未搜图'}
          </Typography.Text>
        </Space>
      )
    },
    {
      title: '状态',
      dataIndex: 'status',
      width: 92,
      render: (v: string) => (
        <Tag color={v === 'running' ? 'processing' : v === 'paused' ? 'warning' : v === 'archived' ? 'default' : 'blue'}>
          {statusLabel(v)}
        </Tag>
      )
    },
    { title: '阶段', dataIndex: 'stage', width: 90, render: (v: string) => <Tag>{stageLabel(v)}</Tag> },
    {
      title: '进度',
      width: 160,
      render: (_: unknown, r: Campaign) => {
        const total = settings.data?.settings.inquiry_count || 10;
        const done = Number(r.contact_count || 0);
        return (
          <Tooltip title={`已联系 ${done} 家 / 目标 ${total} 家 · 页面价 ${r.offer_count ?? 0} 条 · 报价 ${r.quote_count ?? 0} 条`}>
            <div>
              <Progress percent={Math.min(100, Math.round((done / total) * 100))} size="small" />
              <div style={{ fontSize: 11, color: '#8b98ad' }}>
                联系 {done} · 报价 {r.quote_count ?? 0}
              </div>
            </div>
          </Tooltip>
        );
      }
    },
    { title: '创建时间', dataIndex: 'created_at', width: 150, render: (v: number) => fmtTime(v, false) },
    {
      title: '操作',
      width: 410,
      fixed: 'right' as const,
      render: (_: unknown, r: Campaign) => {
        /* 归档后是只读留档：所有"会动浏览器/发消息"的按钮禁掉，只留详情 + 取消归档 */
        const frozen = r.status === 'archived';
        const frozenTip = '任务已归档（只读）。要继续操作请先点「取消归档」。';
        const paused = r.status === 'paused';
        const pauseTip = paused
          ? '恢复任务状态（不会自动重启已终止的流程）'
          : '暂停任务：停止后续调度，不立即打断当前流程；要终止本次流程请到任务中心操作';
        return (
          <Space size={4} wrap>
            <Tooltip title={frozen ? frozenTip : '启动、采集、AI 分析、飞书推送全流程'}>
              <Button
                size="small"
                type="primary"
                icon={<RocketOutlined />}
                disabled={frozen}
                onClick={() => openAuto(r, 'full')}
              >
                全自动比价
              </Button>
            </Tooltip>
            <Tooltip title={frozen ? frozenTip : pauseTip}>
              <Button
                size="small"
                disabled={frozen}
                icon={paused ? <PlayCircleOutlined /> : <PauseCircleOutlined />}
                onClick={() => toggle(r)}
              >
                {paused ? '恢复' : '暂停'}
              </Button>
            </Tooltip>
            <Button size="small" icon={<EyeOutlined />} onClick={() => openDetail(r)}>
              查看
            </Button>
            {frozen ? (
              <Popconfirm
                title="取消归档？"
                description="任务会回到「已暂停」状态，不会自动开跑。"
                okText="取消归档"
                cancelText="算了"
                onConfirm={() => unarchive(r)}
              >
                <Button size="small" icon={<PlayCircleOutlined />}>取消归档</Button>
              </Popconfirm>
            ) : (
              <Popconfirm
                title="确认归档该任务？"
                description="归档后任务冻结（不能再启动/采集/追问），并自动导出最终比价表 CSV 留档；数据不会被删除。"
                okText="归档"
                cancelText="取消"
                onConfirm={() => archive(r)}
              >
                <Button size="small" danger icon={<InboxOutlined />}>归档</Button>
              </Popconfirm>
            )}
            <Dropdown
              trigger={['click']}
              menu={{
                items: [
                  { key: 'launch', icon: <ThunderboltOutlined />, label: '启动', disabled: frozen },
                  { key: 'collect', icon: <SyncOutlined />, label: '采集', disabled: frozen },
                  { key: 'auto', icon: <ThunderboltOutlined />, label: '自动采集', disabled: frozen },
                  { key: 'advance', icon: <CaretRightOutlined />, label: '推进', disabled: frozen },
                  { key: 'audit', icon: <RobotOutlined />, label: '补分析', disabled: frozen },
                  { key: 'resend', icon: <RedoOutlined />, label: '补发询价', danger: true, disabled: frozen },
                ],
                onClick: ({ key }) => {
                  if (frozen) {
                    message.warning(frozenTip);
                    return;
                  }
                  if (key === 'launch') launch(r);
                  if (key === 'collect') collect(r);
                  if (key === 'auto') openAuto(r);
                  if (key === 'advance') advance(r);
                  if (key === 'audit') audit(r);
                  if (key === 'resend') confirmResend(r);
                }
              }}
            >
              <Button size="small" icon={<MoreOutlined />}>更多</Button>
            </Dropdown>
          </Space>
        );
      }
    }
  ];

  return (
    <Space direction="vertical" size={16} style={{ width: '100%' }}>
      <Alert
        type="warning"
        showIcon
        message="启动任务会真实对外发送"
        description="「启动」= 以图搜图 + AI 按商品名称审核采购品类（不符合自动跳过）+ 逐个联系符合项并真实发送询价短语与图片；「采集」= 读取回复并交给 AI 解析（每个会话最多一条）；「自动采集」= 每个客户独立计时、回复立即入队做 AI 问答、超时最多追问 2 次后静默；「补发」= 只把没发成功的询价短语重发一遍。请在参数设置里确认询价客户数量后再执行。"
      />

      <Card
        title="比价任务"
        extra={
          <Space>
            <Tooltip title="已归档的任务默认不显示（只读留档）。想看/恢复就打开这个开关">
              <Space size={6}>
                <span style={{ fontSize: 12, color: '#5a6b85' }}>显示已归档</span>
                <Switch size="small" checked={showArchived} onChange={setShowArchived} />
              </Space>
            </Tooltip>
            <Button icon={<ReloadOutlined />} onClick={refreshTabs}>
              收敛标签页
            </Button>
            <Button icon={<ReloadOutlined />} onClick={refreshPages}>
              刷新聊天页
            </Button>
            <Button type="primary" icon={<PlusOutlined />} onClick={() => setOpen(true)}>
              新建任务
            </Button>
          </Space>
        }
        styles={{ body: { padding: 12 } }}
      >
        <Table
          rowKey="id"
          size="middle"
          loading={campaigns.isLoading}
          dataSource={campaigns.data?.items || []}
          columns={columns}
          scroll={{ x: 1312 }}
          tableLayout="fixed"
          pagination={{ pageSize: 10, showSizeChanger: false }}
        />
      </Card>

      <Modal
        open={open}
        title="新建比价任务"
        onCancel={() => setOpen(false)}
        onOk={() => form.submit()}
        okText="创建"
        width={640}
      >
        <Form form={form} layout="vertical" onFinish={create} requiredMark={false}>
          <Form.Item name="name" label="任务名称" rules={[{ required: true, message: '请输入任务名称' }]}>
            <Input placeholder="例如：金色羽毛笔-400支" />
          </Form.Item>
          <Form.Item
            name="template_id"
            label="业务参数模版"
            extra="选择后立即套用方案中的发送模式、询价客户数、并发会话数和预期价格要求；下方参数仍可手动调整。"
          >
            <Select
              allowClear
              loading={pricingTemplates.isLoading}
              placeholder="不使用方案，沿用全局或手动填写"
              onChange={(value?: number) => applyTemplate(value)}
              options={(pricingTemplates.data?.items || []).map((item) => ({
                value: item.id,
                label: `${item.name}（${item.inquiry_count} 家 / 并发 ${item.slice_per_round}）`
              }))}
            />
          </Form.Item>
          {selectedTemplate ? (
            <Alert
              type="success"
              showIcon
              style={{ marginTop: -8, marginBottom: 14 }}
              message={`已套用方案：${selectedTemplate.name}`}
              description={
                `${selectedTemplate.send_mode} · 询价 ${selectedTemplate.inquiry_count} 家 · 并发 ${selectedTemplate.slice_per_round} 个 · ` +
                `预期单价 ${selectedTemplate.expected_price == null ? '未设置' : `¥${selectedTemplate.expected_price}`}` +
                `${selectedTemplate.expected_price_note ? `（${selectedTemplate.expected_price_note}）` : ''} · ` +
                `超时追问 ${selectedTemplate.max_followups} 次 · 最长运行 ${selectedTemplate.duration_sec ? `${selectedTemplate.duration_sec} 秒` : '不限时'} · ` +
                `客户超时 ${selectedTemplate.reply_timeout_sec} 秒`
              }
            />
          ) : null}
          <Form.Item name="phrase_id" label="询价快捷短语">
            <Select
              allowClear
              placeholder="从快捷短语库选择"
              options={(phrases.data?.items || []).map((p) => ({
                value: p.id,
                label: `${p.name}${p.image ? '（含配图）' : ''}（${p.keyword ? `关键词：${p.keyword} · ` : ''}${p.text.slice(0, 18)}…）`
              }))}
              onChange={onPhraseChange}
            />
          </Form.Item>
          <Form.Item
            name="image"
            label="产品图片"
            dependencies={['phrase_id']}
            extra="选择带配图的询价快捷短语会自动带入配图；也可以手动选图覆盖。"
            rules={[
              ({ getFieldValue }) => ({
                validator(_, value?: string) {
                  const phrase = (phrases.data?.items || []).find(
                    (p) => p.id === getFieldValue('phrase_id')
                  );
                  if (value || phrase?.image) return Promise.resolve();
                  return Promise.reject(new Error('请选择产品图片，或选择一条带配图的询价快捷短语'));
                }
              })
            ]}
          >
            <Select
              placeholder="从图片库选择"
              options={(images.data?.items || []).map((i) => ({ value: i.path, label: i.fileName }))}
              showSearch
            />
          </Form.Item>
          {formImage ? (
            <Space align="start" style={{ marginTop: -10, marginBottom: 14 }}>
              <Image
                src={imgUrl(formImage)}
                width={56}
                height={56}
                style={{ objectFit: 'cover', borderRadius: 8, border: '1px solid #eef1f6' }}
              />
              <Typography.Text style={{ fontSize: 12, color: '#8b98ad' }}>
                当前产品图
                <br />
                用于搜图，也会随询价短语发给商家
              </Typography.Text>
            </Space>
          ) : null}
          <Form.Item name="note" label="备注">
            <Input.TextArea rows={2} placeholder="选填" />
          </Form.Item>

          <Collapse
            ghost
            items={[
              {
                key: 'params',
                label: (
                  <span style={{ fontSize: 13 }}>
                    业务参数（选填，留空 = 用「参数设置」里的全局默认）
                  </span>
                ),
                children: (
                  <>
                    <Divider style={{ margin: '2px 0 14px' }} />
                    <Row gutter={16}>
                      <Col span={12}>
                        <Form.Item
                          name={['params', 'send_mode']}
                          label="发送模式"
                          extra={`留空 = 全局：${settings.data?.settings.send_mode ?? '-'}`}
                        >
                          <Select
                            allowClear
                            placeholder="用全局默认"
                            options={[
                              { value: 'send', label: 'send · 真实发送' },
                              { value: 'draft', label: 'draft · 只填草稿' },
                              { value: 'dry', label: 'dry · 只解析不发送' }
                            ]}
                          />
                        </Form.Item>
                      </Col>
                      <Col span={12}>
                        <Form.Item
                          name={['params', 'inquiry_count']}
                          label="询价客户数量（本任务联系几家）"
                          extra={`留空 = 全局：${settings.data?.settings.inquiry_count ?? '-'} 家`}
                        >
                          <InputNumber min={0} max={500} style={{ width: '100%' }} placeholder="用全局默认" addonAfter="家" />
                        </Form.Item>
                      </Col>
                      <Col span={12}>
                        <Form.Item
                          name={['params', 'slice_per_round']}
                          label="同时处理会话数（队列轮转粒度）"
                          extra={`队列轮转粒度；留空 = 全局：${settings.data?.settings.slice_per_round ?? '-'} 个会话（客户）`}
                        >
                          <InputNumber min={1} max={50} style={{ width: '100%' }} placeholder="用全局默认" addonAfter="个" />
                        </Form.Item>
                      </Col>
                      <Col span={12}>
                        <Form.Item
                          name={['params', 'expected_price']}
                          label="预期单价上限"
                          extra={
                            settings.data?.settings.expected_price != null
                              ? `留空 = 全局：¥${settings.data.settings.expected_price}`
                              : '留空 = 全局未设置'
                          }
                        >
                          <InputNumber
                            min={0}
                            step={0.01}
                            style={{ width: '100%' }}
                            placeholder="用全局默认"
                            addonBefore="¥"
                          />
                        </Form.Item>
                      </Col>
                      <Col span={24}>
                        <Form.Item name={['params', 'expected_price_note']} label="预期价格说明">
                          <Input placeholder="留空 = 用全局默认，例如：含税含运，400 支起订" />
                        </Form.Item>
                      </Col>
                      <Col span={8}>
                        <Form.Item
                          name={['params', 'max_followups']}
                          label="超时后最多主动追问"
                          extra="留空 = 默认 2 次"
                        >
                          <InputNumber min={0} max={2} style={{ width: '100%' }} placeholder="默认" addonAfter="次" />
                        </Form.Item>
                      </Col>
                      <Col span={8}>
                        <Form.Item
                          name={['params', 'duration_sec']}
                          label="任务最长运行时长"
                          extra="留空 = 不限时；单位秒"
                        >
                          <InputNumber min={0} max={86400} style={{ width: '100%' }} placeholder="不限时" addonAfter="秒" />
                        </Form.Item>
                      </Col>
                      <Col span={8}>
                        <Form.Item
                          name={['params', 'reply_timeout_sec']}
                          label="每客户超时判定"
                          extra="留空 = 默认 60 秒"
                        >
                          <InputNumber min={1} max={86400} style={{ width: '100%' }} placeholder="默认" addonAfter="秒" />
                        </Form.Item>
                      </Col>
                    </Row>
                    <Typography.Text style={{ fontSize: 12, color: '#98a4b8' }}>
                      「最多询价客户数量」是跨任务的安全上限，仍在「参数设置」里统一控制。
                    </Typography.Text>
                  </>
                )
              }
            ]}
            style={{ background: '#f7f9fc', borderRadius: 8, padding: '0 12px', marginBottom: 8 }}
          />
        </Form>
      </Modal>

      <Modal
        open={autoOpen}
        title={
          autoCampaign
            ? `${autoMode === 'full' ? '全自动比价' : '自动采集'}《${autoCampaign.name}》`
            : autoMode === 'full'
              ? '全自动比价'
              : '自动采集'
        }
        onCancel={() => setAutoOpen(false)}
        onOk={() => autoForm.submit()}
        okText={autoMode === 'full' ? '开始全自动比价' : '开始'}
        width={700}
      >
        <Form form={autoForm} layout="vertical" onFinish={submitAuto} requiredMark={false}>
          <Form.Item
            name="template_id"
            label="业务参数模板"
            extra="选择后自动带入本任务需要的发送、询价、并发、预期价格和超时参数，并保存到任务；下方仍可临时调整。"
          >
            <Select
              allowClear
              loading={pricingTemplates.isLoading}
              placeholder="不套用模板，使用当前任务参数"
              onChange={(value?: number) => applyAutoTemplate(value)}
              options={(pricingTemplates.data?.items || []).map((item) => ({
                value: item.id,
                label: `${item.name}（${item.send_mode} / ${item.inquiry_count} 家 / 超时 ${item.reply_timeout_sec}s）`
              }))}
            />
          </Form.Item>
          {autoTemplate ? (
            <Alert
              type="success"
              showIcon
              style={{ marginBottom: 14 }}
              message={`已选择配置方案：${autoTemplate.name}`}
              description={
                `发送 ${autoTemplate.send_mode} · 询价 ${autoTemplate.inquiry_count} 家 · 并发 ${autoTemplate.slice_per_round} · ` +
                `追问 ${autoTemplate.max_followups} 次 · 最长 ${autoTemplate.duration_sec ? `${autoTemplate.duration_sec} 秒` : '不限时'} · ` +
                `客户超时 ${autoTemplate.reply_timeout_sec} 秒`
              }
            />
          ) : null}
          {autoMode === 'full' ? (
            <Alert
              type="warning"
              showIcon
              style={{ marginBottom: 14 }}
              message="全自动比价 = 启动 → 自动采集 → 飞书推送（会真实对外发送）"
              description="① 启动：以图搜图 → 联系商家 → 真实发送询价短语与图片；② 自动采集：每家单独计时，回复后立即 AI 解析并正常问答；超时最多主动追问 2 次，之后静默等待；③ 到任务运行时长或手动停止后推送飞书。"
            />
          ) : (
            <Alert
              type="info"
              showIcon
              style={{ marginBottom: 14 }}
              message="每个客户独立计时 → 回复即入队 → 超时最多主动问 2 次"
              description="首次联系后开始计时；客户任何回复都立即进入队列，AI 先回答问题，再提取信息并追问缺失项。超时未回复最多主动追问 2 次，之后静默等待；客户再次回复会重新获得两次超时追问机会。任务到设定时长或手动停止时结束。"
            />
          )}
          {autoMode === 'full' ? (
            <Form.Item
              name="limit"
              label="启动时联系几家商家"
              extra={`留空 = 用本任务生效的「询价客户数量」（当前 ${
                settings.data?.settings.inquiry_count ?? 10
              } 家）`}
            >
              <InputNumber min={1} max={500} style={{ width: '240px' }} addonAfter="家" placeholder="用任务默认" />
            </Form.Item>
          ) : null}
          <Form.Item name="mode" label="发送模式" extra="留空 = 用本任务生效的设置">
            <Select
              allowClear
              placeholder="用任务默认"
              options={[
                { value: 'send', label: 'send · 真实发送' },
                { value: 'draft', label: 'draft · 只填草稿' },
                { value: 'dry', label: 'dry · 只解析不发送' }
              ]}
            />
          </Form.Item>
          <Row gutter={16}>
            <Col span={12}>
              <Form.Item name="max_followups" label="超时后最多主动追问" extra="最多 2 次，之后静默等待客户回复">
                <InputNumber min={0} max={2} style={{ width: '100%' }} addonAfter="次" />
              </Form.Item>
            </Col>
            <Col span={12}>
              <Form.Item name="duration_min" label="任务最长运行时长" extra="到时结束；0 = 由人工停止">
                <InputNumber min={0} max={1440} style={{ width: '100%' }} addonAfter="分钟" />
              </Form.Item>
            </Col>
          </Row>
          <Row gutter={16}>
            <Col span={12}>
              <Form.Item name="timeout_sec" label="每客户超时判定" extra="首次联系或追问发出后，多久没回复就再次追问">
                <InputNumber min={1} max={86400} style={{ width: '100%' }} addonAfter="秒" />
              </Form.Item>
            </Col>
          </Row>
          <Form.Item name="followup_text" label="催问话术" extra="留空 = 自动用「产品名 + 单价/起订量/运费/工期」模板">
            <Input.TextArea rows={2} placeholder="选填" />
          </Form.Item>
          <Form.Item name="ensure_sent" label="开跑前补发询价短语" valuePropName="checked" extra="把上次没发成功的询价补上">
            <Switch />
          </Form.Item>
          <Row gutter={16}>
            <Col span={12}>
              <Form.Item name="send_table" label="结束后发送会话表" valuePropName="checked">
                <Switch />
              </Form.Item>
            </Col>
          </Row>
          <Form.Item noStyle shouldUpdate={(p, c) => p.send_table !== c.send_table}>
            {({ getFieldValue }) =>
              getFieldValue('send_table') ? (
                <Form.Item
                  name="table_target"
                  label="会话表发送到"
                  rules={[{ required: true, message: '请填接收会话（店铺名或旺旺号）' }]}
                  extra="采集结束后把本次会话表作为一条消息发给这个会话"
                >
                  <Input placeholder="例如：文件传输助手 / 某个旺旺号" />
                </Form.Item>
              ) : null
            }
          </Form.Item>
          {autoMode === 'full' ? (
            <>
              <Divider style={{ margin: '6px 0 14px' }} />
              <Row gutter={16}>
                <Col span={12}>
                  <Form.Item
                    name="send_feishu"
                    label="结束后推送飞书"
                    valuePropName="checked"
                    extra="发比价表总结 + 比价表文件"
                  >
                    <Switch />
                  </Form.Item>
                </Col>
                <Col span={12}>
                  <Form.Item
                    name="feishu_file"
                    label="同时发送比价表文件"
                    valuePropName="checked"
                    extra="需要应用机器人模式，Webhook 只能发总结"
                  >
                    <Switch />
                  </Form.Item>
                </Col>
              </Row>
              <Form.Item name="feishu_chat_id" label="飞书群 ID" extra="留空 = 用 .env 里配置的默认群（FEISHU_CHAT_ID / FEISHU_GROUP_WHITELIST）">
                <Input placeholder="选填，例如 oc_xxxxxxxx" />
              </Form.Item>
            </>
          ) : null}
        </Form>
      </Modal>

      <Modal open={!!detail} title={detail ? `任务详情 #${detail.id} ${detail.name}` : ''} onCancel={() => setDetail(null)} footer={null} width={720}>
        {detail ? (
          <Space direction="vertical" size={12} style={{ width: '100%' }}>
            <Space wrap>
              <Tag color="blue">状态：{statusLabel(detail.status)}</Tag>
              <Tag>阶段：{stageLabel(detail.stage)}</Tag>
              <Tag>imageId：{detail.image_id || '-'}</Tag>
              <Tag>短语：{detail.phrase_id || '-'}</Tag>
            </Space>
            <Space wrap>
              <Button size="small" icon={<SendOutlined />} onClick={() => pushFeishu(detail)}>
                推送比价表到飞书
              </Button>
              <Button
                size="small"
                icon={<DownloadOutlined />}
                href={`/api/campaigns/${detail.id}/price-report.csv`}
                target="_blank"
              >
                下载比价表 CSV
              </Button>
            </Space>
            <div>
              <Space size={8}>
                <Typography.Text strong>业务参数（生效值）</Typography.Text>
                {detail.params_customized ? <Tag color="purple">本任务已自定义</Tag> : <Tag>全部沿用全局默认</Tag>}
              </Space>
              <div style={{ marginTop: 6, fontSize: 13, color: '#5a6b85' }}>
                发送模式 <b>{String(detail.params_effective?.send_mode ?? '-')}</b> · 询价客户数量{' '}
                <b>{String(detail.params_effective?.inquiry_count ?? '-')}</b> 家 · 同时处理会话{' '}
                <b>{String(detail.params_effective?.slice_per_round ?? '-')}</b> 个（客户） · 预期单价{' '}
                <b>
                  {detail.params_effective?.expected_price != null
                    ? `¥${detail.params_effective.expected_price}`
                    : '未设置'}
                </b>
              </div>
            </div>
            <div>
              <Typography.Text strong>已联系商家（{detail.contacts?.length || 0}）</Typography.Text>
              <Table
                size="small"
                rowKey={(r: Record<string, unknown>) => String(r.id)}
                style={{ marginTop: 8 }}
                pagination={{ pageSize: 5, showSizeChanger: false }}
                scroll={{ x: 670 }}
                tableLayout="fixed"
                dataSource={(detail.contacts || []) as Array<Record<string, unknown>>}
                columns={[
                  { title: '排名', dataIndex: 'rank', width: 60 },
                  { title: '店铺', dataIndex: 'shop_name', width: 220, ellipsis: true },
                  { title: '旺旺', dataIndex: 'seller_nick', width: 160, ellipsis: true },
                  { title: 'offerId', dataIndex: 'offer_id', width: 140 },
                  { title: '状态', dataIndex: 'status', width: 90 }
                ]}
              />
            </div>
          </Space>
        ) : null}
      </Modal>

      {runner.node}
    </Space>
  );
}
