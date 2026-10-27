import { useEffect, useState } from 'react';
import { Alert, Button, Divider, Form, Input, Space, Tag, Typography, message } from 'antd';
import { ApiOutlined, LockOutlined, SafetyCertificateOutlined, UserOutlined } from '@ant-design/icons';
import { useNavigate, useSearchParams } from 'react-router-dom';

import { get, post, detailOf } from '../api/client';
import { useAuth } from '../auth/AuthContext';

interface AuthConfig {
  sso_login_url: string;
  sso_callback_url: string;
  portal_api_base_url: string;
  allow_dev_login: boolean;
}

export default function Login() {
  const [params] = useSearchParams();
  const navigate = useNavigate();
  const { refresh } = useAuth();
  const [cfg, setCfg] = useState<AuthConfig | null>(null);
  const [loading, setLoading] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const redirect = params.get('redirect') || '/';

  useEffect(() => {
    get<AuthConfig>('/api/auth/config')
      .then(setCfg)
      .catch(() => setCfg(null));
  }, []);

  const gotoPortal = () => {
    const url = '/api/auth/sso-redirect?path=' + encodeURIComponent(redirect);
    // 如果本页被嵌在门户的 iframe 里（open_mode=embedded），尽量让顶层窗口跳转：
    // 否则门户登录页会被塞进 iframe，多半被对方的安全策略挡掉，页面变空白。
    try {
      if (window.top && window.top !== window.self) {
        window.top.location.href = url;
        return;
      }
    } catch {
      /* 跨域受限时忽略，退回当前窗口跳转 */
    }
    window.location.href = url;
  };

  const onDevLogin = async (values: { username: string; password: string }) => {
    setLoading(true);
    setErr(null);
    try {
      await post('/api/auth/dev-login', values);
      await refresh();
      message.success('登录成功');
      navigate(redirect, { replace: true });
    } catch (e) {
      setErr(detailOf(e));
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="ais-login">
      <div className="ais-login-panel">
        <div className="ais-login-hero">
          <div className="ais-brand-logo" style={{ width: 40, height: 40, fontSize: 19 }}>
            询
          </div>
          <h1>自动询价系统</h1>
          <p>
            1688 比价议价的统一工作台
            <br />
            以图搜图 → 自动询价 → 收集报价 → 出比价表
          </p>
          <div className="ais-login-feat">
            <div>
              <ApiOutlined /> 单队列串行调度，多任务互不抢窗口
            </div>
            <div>
              <SafetyCertificateOutlined /> 企业门户统一认证（JWT 单点登录）
            </div>
            <div>
              <LockOutlined /> 浏览器动作与数据查询物理隔离
            </div>
          </div>
        </div>

        <div className="ais-login-form">
          <Typography.Title level={4} style={{ marginBottom: 4 }}>
            登录
          </Typography.Title>
          <Typography.Text className="ais-muted">
            推荐使用企业门户账号单点登录
            <Tag color="blue" style={{ marginLeft: 8 }}>
              V1.0
            </Tag>
          </Typography.Text>

          <Space direction="vertical" size={14} style={{ width: '100%', marginTop: 22 }}>
            <Button type="primary" size="large" block icon={<SafetyCertificateOutlined />} onClick={gotoPortal}>
              企业门户登录（SSO）
            </Button>

            {cfg?.allow_dev_login ? (
              <>
                <Divider plain style={{ margin: '6px 0', fontSize: 12, color: '#9aa6b8' }}>
                  或使用本地调试账号
                </Divider>
                {err ? <Alert type="error" showIcon message={err} /> : null}
                <Form layout="vertical" onFinish={onDevLogin} requiredMark={false} initialValues={{ username: 'admin' }}>
                  <Form.Item name="username" rules={[{ required: true, message: '请输入用户名' }]} style={{ marginBottom: 12 }}>
                    <Input size="large" prefix={<UserOutlined />} placeholder="用户名" autoComplete="username" />
                  </Form.Item>
                  <Form.Item name="password" rules={[{ required: true, message: '请输入密码' }]} style={{ marginBottom: 14 }}>
                    <Input.Password
                      size="large"
                      prefix={<LockOutlined />}
                      placeholder="密码"
                      autoComplete="current-password"
                      onPressEnter={(e) => (e.currentTarget.form as HTMLFormElement | null)?.requestSubmit()}
                    />
                  </Form.Item>
                  <Button type="default" size="large" block htmlType="submit" loading={loading}>
                    本地登录
                  </Button>
                </Form>
                <Typography.Text style={{ fontSize: 12, color: '#9aa6b8' }}>
                  调试账号：admin / admin123 · gm / gm123 · user / user123
                  <br />
                  生产环境请把 <code>ALLOW_DEV_LOGIN</code> 设为 false 关闭此入口。
                </Typography.Text>
              </>
            ) : (
              <Typography.Text style={{ fontSize: 12, color: '#9aa6b8' }}>
                本地调试登录已关闭。若门户暂时不可用，请在服务端将 <code>ALLOW_DEV_LOGIN</code> 设为 true。
              </Typography.Text>
            )}
          </Space>
        </div>
      </div>
    </div>
  );
}
