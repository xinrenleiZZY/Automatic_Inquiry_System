import { useEffect, useState } from 'react';
import { Alert, Button, Card, Col, Descriptions, Divider, Form, InputNumber, Input, Row, Select, Space, Tag, Typography, message } from 'antd';
import { SaveOutlined, SettingOutlined } from '@ant-design/icons';
import { useQuery, useQueryClient } from '@tanstack/react-query';

import { detailOf, get, put } from '../api/client';
import type { Settings as SettingsT } from '../api/types';

interface ConfigResp {
  runtime: Record<string, unknown>;
  settings: SettingsT;
}

/** 本页能改的业务参数白名单（其余键由各自的页面管，提交时一律不带） */
const BUSINESS_KEYS: Array<keyof SettingsT> = [
  'send_mode',
  'inquiry_count',
  'max_inquiry_count',
  'expected_price',
  'expected_price_note',
  'slice_per_round',
  'min_interval_ms',
  'max_per_hour',
  'quiet_hours_start',
  'quiet_hours_end',
  'auto_refresh_min',
  'scheduler_round_sec'
];

export default function SettingsPage() {
  const qc = useQueryClient();
  const [form] = Form.useForm<SettingsT>();
  const [saving, setSaving] = useState(false);
  const [effective, setEffective] = useState<SettingsT | null>(null);

  const cfg = useQuery({ queryKey: ['system-config'], queryFn: () => get<ConfigResp>('/api/system/config') });

  useEffect(() => {
    if (cfg.data?.settings) {
      form.setFieldsValue(cfg.data.settings);
      setEffective(cfg.data.settings);
    }
  }, [cfg.data, form]);

  useEffect(() => {
    const h = () => void qc.invalidateQueries({ queryKey: ['system-config'] });
    window.addEventListener('ais:refresh', h);
    return () => window.removeEventListener('ais:refresh', h);
  }, [qc]);

  const save = async (values: SettingsT) => {
    setSaving(true);
    try {
      /* 只提交本页真正管得着的业务参数。
         /api/settings 对未知字段是 extra=forbid，而 setFieldsValue 会把
         chrome_exe / login_account 这类"别的页面管"的键也灌进表单 store，
         不挑出来就会被一起提交、直接 422（chrome_exe 那次实测踩过）。 */
      const payload = Object.fromEntries(BUSINESS_KEYS.map((k) => [k, values[k]]));
      const r = await put<{ settings: SettingsT }>('/api/settings', payload);
      setEffective(r.settings);
      message.success('参数已保存，下一轮生效');
      void qc.invalidateQueries({ queryKey: ['system-config'] });
      void qc.invalidateQueries({ queryKey: ['settings'] });
    } catch (e) {
      message.error(detailOf(e));
    } finally {
      setSaving(false);
    }
  };

  const rt = cfg.data?.runtime || {};

  return (
    <Space direction="vertical" size={16} style={{ width: '100%' }}>
      <Alert
        type="info"
        showIcon
        message="参数说明"
        description="这里的参数会翻译成对冻结源码的调用参数，无需改一行源码即可生效。发送模式建议生产环境保持 send（真实发送），风控紧张时可临时改为 dry 只解析不发。"
      />

      <Row gutter={[16, 16]}>
        <Col xs={24} lg={14}>
          <Card title={<Space><SettingOutlined />业务参数</Space>}>
            <Form form={form} layout="vertical" onFinish={save} requiredMark={false}>
              <Row gutter={16}>
                <Col span={12}>
                  <Form.Item
                    name="send_mode"
                    label="发送模式"
                    tooltip="send=真实发送；draft=只填草稿等人点发送；dry=只解析不发送"
                  >
                    <Select
                      options={[
                        { value: 'send', label: 'send · 真实发送（生产）' },
                        { value: 'draft', label: 'draft · 只填草稿' },
                        { value: 'dry', label: 'dry · 只解析不发送' }
                      ]}
                    />
                  </Form.Item>
                </Col>
                <Col span={12}>
                  <Form.Item name="inquiry_count" label="询价客户数量（每个任务联系几家）" tooltip="对应联系商家时的 limit">
                    <InputNumber min={0} max={500} style={{ width: '100%' }} addonAfter="家" />
                  </Form.Item>
                </Col>
                <Col span={12}>
                  <Form.Item name="max_inquiry_count" label="最多询价客户数量（全局上限）" tooltip="所有任务累计联系商家数的上限，超出会被拒绝">
                    <InputNumber min={0} max={100000} style={{ width: '100%' }} addonAfter="家" />
                  </Form.Item>
                </Col>
                <Col span={12}>
                  <Form.Item
                    name="slice_per_round"
                    label="同时处理会话数（队列轮转粒度）"
                    tooltip="每个队列轮转步同时纳入处理的会话（客户）数量；聊天窗口操作仍由队列串行执行，避免串会话"
                  >
                    <InputNumber min={1} max={50} style={{ width: '100%' }} addonAfter="个" />
                  </Form.Item>
                </Col>
              </Row>

              <Divider orientation="left" plain style={{ fontSize: 13 }}>
                预期价格要求
              </Divider>
              <Row gutter={16}>
                <Col span={12}>
                  <Form.Item name="expected_price" label="预期单价上限" tooltip="比价表会按这个值标记「达标/超标」，不填写则不判定">
                    <InputNumber min={0} step={0.01} style={{ width: '100%' }} placeholder="例如 0.75" addonBefore="¥" />
                  </Form.Item>
                </Col>
                <Col span={12}>
                  <Form.Item name="expected_price_note" label="预期价格说明">
                    <Input placeholder="例如：含税含运，400 支起订" />
                  </Form.Item>
                </Col>
              </Row>

              <Divider orientation="left" plain style={{ fontSize: 13 }}>
                发送护栏
              </Divider>
              <Row gutter={16}>
                <Col span={12}>
                  <Form.Item name="min_interval_ms" label="同一客户最小发送间隔">
                    <InputNumber min={0} step={1000} style={{ width: '100%' }} addonAfter="毫秒" />
                  </Form.Item>
                </Col>
                <Col span={12}>
                  <Form.Item name="max_per_hour" label="全局每小时最多发送">
                    <InputNumber min={0} max={1000} style={{ width: '100%' }} addonAfter="条" />
                  </Form.Item>
                </Col>
                <Col span={12}>
                  <Form.Item name="quiet_hours_start" label="免打扰开始（小时，24 小时制）">
                    <InputNumber min={0} max={23} style={{ width: '100%' }} placeholder="留空不启用" />
                  </Form.Item>
                </Col>
                <Col span={12}>
                  <Form.Item name="quiet_hours_end" label="免打扰结束（小时）">
                    <InputNumber min={0} max={23} style={{ width: '100%' }} placeholder="留空不启用" />
                  </Form.Item>
                </Col>
                <Col span={12}>
                  <Form.Item name="auto_refresh_min" label="聊天页刷新间隔" tooltip="0 = 不在监听里刷新，改由队列在空闲点刷新">
                    <InputNumber min={0} max={1440} style={{ width: '100%' }} addonAfter="分钟" />
                  </Form.Item>
                </Col>
                <Col span={12}>
                  <Form.Item name="scheduler_round_sec" label="队列轮转间隔">
                    <InputNumber min={10} max={86400} style={{ width: '100%' }} addonAfter="秒" />
                  </Form.Item>
                </Col>
              </Row>

              <Button type="primary" htmlType="submit" icon={<SaveOutlined />} loading={saving}>
                保存参数
              </Button>
            </Form>
          </Card>
        </Col>

        <Col xs={24} lg={10}>
          <Card title="当前生效值">
            {effective ? (
              <Descriptions size="small" column={1} bordered>
                <Descriptions.Item label="发送模式">
                  <Tag color={effective.send_mode === 'send' ? 'red' : 'blue'}>{effective.send_mode}</Tag>
                </Descriptions.Item>
                <Descriptions.Item label="询价客户数量">{effective.inquiry_count} 家</Descriptions.Item>
                <Descriptions.Item label="全局上限">{effective.max_inquiry_count} 家</Descriptions.Item>
                <Descriptions.Item label="同时处理会话">{effective.slice_per_round} 个会话（客户）</Descriptions.Item>
                <Descriptions.Item label="预期单价">
                  {effective.expected_price != null ? `¥ ${effective.expected_price}` : '未设置'}
                </Descriptions.Item>
                <Descriptions.Item label="发送间隔">{effective.min_interval_ms} ms</Descriptions.Item>
                <Descriptions.Item label="每小时上限">{effective.max_per_hour} 条</Descriptions.Item>
                <Descriptions.Item label="免打扰">
                  {effective.quiet_hours_start != null && effective.quiet_hours_end != null
                    ? `${effective.quiet_hours_start}:00 – ${effective.quiet_hours_end}:00`
                    : '未启用'}
                </Descriptions.Item>
              </Descriptions>
            ) : (
              <Typography.Text type="secondary">加载中…</Typography.Text>
            )}
          </Card>

          <Card title="运行环境" style={{ marginTop: 16 }}>
            <Descriptions size="small" column={1}>
              <Descriptions.Item label="事实库">
                <Typography.Text style={{ fontSize: 12 }} copyable>
                  {String(rt.im_db || '-')}
                </Typography.Text>
              </Descriptions.Item>
              <Descriptions.Item label="桥接脚本">
                <Typography.Text style={{ fontSize: 12 }} copyable>
                  {String(rt.bridge_script || '-')}
                </Typography.Text>
              </Descriptions.Item>
              <Descriptions.Item label="图片库目录">
                <Typography.Text style={{ fontSize: 12 }} copyable>
                  {String(rt.image_dir || '-')}
                </Typography.Text>
              </Descriptions.Item>
              <Descriptions.Item label="Chrome 调试端口">{String(rt.cdp_base || '-')}</Descriptions.Item>
              <Descriptions.Item label="Chrome 路径">
                {effective?.chrome_exe ? (
                  <Typography.Text style={{ fontSize: 12 }} copyable>
                    {effective.chrome_exe}
                  </Typography.Text>
                ) : (
                  <Tag>自动检测</Tag>
                )}
                <Typography.Text type="secondary" style={{ fontSize: 12, marginLeft: 8 }}>
                  在「状态监控」页可改 / 可重新检测
                </Typography.Text>
              </Descriptions.Item>
              <Descriptions.Item label="调试 profile">{String(rt.chrome_profile_dir || '-')}</Descriptions.Item>
              <Descriptions.Item label="企业门户 API">{String(rt.portal_api_base_url || '-')}</Descriptions.Item>
              <Descriptions.Item label="SSO 回调地址">{String(rt.sso_callback_url || '-')}</Descriptions.Item>
              <Descriptions.Item label="本地调试登录">
                {rt.allow_dev_login ? <Tag color="orange">已开启</Tag> : <Tag color="green">已关闭</Tag>}
              </Descriptions.Item>
              <Descriptions.Item label="前端构建产物">
                {rt.frontend_dist_exists ? <Tag color="green">已就绪</Tag> : <Tag color="red">未构建</Tag>}
              </Descriptions.Item>
            </Descriptions>
          </Card>
        </Col>
      </Row>
    </Space>
  );
}
