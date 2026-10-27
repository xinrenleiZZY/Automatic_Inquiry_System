import { useMemo, useState } from 'react';
import { Alert, Avatar, Badge, Button, Dropdown, Layout, Menu, Space, Tag, Tooltip, Typography } from 'antd';
import { LogoutOutlined, MenuFoldOutlined, MenuUnfoldOutlined, ReloadOutlined, UserOutlined } from '@ant-design/icons';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Link, Outlet, useLocation, useNavigate } from 'react-router-dom';

import { useAuth } from '../auth/AuthContext';
import { NAV } from '../nav';
import { get } from '../api/client';
import type { Job } from '../api/types';
import { fmtTime } from '../utils/format';
import { jobCN } from '../utils/jobLabel';

const { Sider, Header, Content } = Layout;

/* 失败告警条的"已忽略"记录（只存在这台浏览器里，换人/换浏览器照样能看到） */
const DISMISS_KEY = 'ais:failed-alert-dismissed';
/* 只看 24 小时内的失败，避免历史失败一直挂在顶上 */
const ALERT_WINDOW_MS = 24 * 60 * 60 * 1000;

const ROLE_LABEL: Record<string, { text: string; color: string }> = {
  admin: { text: '管理员', color: 'red' },
  gm: { text: '管理经理', color: 'gold' },
  user: { text: '普通用户', color: 'blue' }
};

interface NavConfig {
  developer_url: string;
  developer_name: string;
  copyright: string;
}

export default function AppLayout() {
  const { user, logout, canManage } = useAuth();
  const qc = useQueryClient();
  const location = useLocation();
  const navigate = useNavigate();
  const [collapsed, setCollapsed] = useState(false);
  const [refreshing, setRefreshing] = useState(false);
  const [dismissed, setDismissed] = useState<string[]>(() => {
    try {
      const raw = JSON.parse(localStorage.getItem(DISMISS_KEY) || '[]');
      return Array.isArray(raw) ? (raw as string[]) : [];
    } catch {
      return [];
    }
  });

  /* 失败告警：队列里任何作业失败都会在 jobs 表留 status=failed + error，
   * 这里全站顶部提示（同一份数据飞书群里也会收到一条卡片）。 */
  const failAlerts = useQuery({
    queryKey: ['job-alerts'],
    queryFn: () => get<{ items: Job[] }>('/api/jobs', { limit: 10, status: 'failed' }),
    refetchInterval: 20_000
  });

  const recentFailed = useMemo(() => {
    const now = Date.now();
    return (failAlerts.data?.items || []).filter(
      (j) =>
        j.status === 'failed' &&
        !dismissed.includes(j.id) &&
        now - (j.finished_at || j.created_at || 0) < ALERT_WINDOW_MS
    );
  }, [failAlerts.data, dismissed]);
  const newest = recentFailed[0];

  const dismissAlert = (id: string) => {
    const next = Array.from(new Set([...dismissed, id])).slice(-50);
    setDismissed(next);
    try {
      localStorage.setItem(DISMISS_KEY, JSON.stringify(next));
    } catch {
      /* 隐私模式下写不了就算了，本次会话内仍然生效 */
    }
  };

  /* 底部开发者入口 / 版权文案走配置，避免写死在页面里 */
  const cfg = useQuery({
    queryKey: ['auth-config'],
    queryFn: () => get<NavConfig>('/api/auth/config'),
    staleTime: 10 * 60 * 1000
  });

  const items = useMemo(
    () =>
      NAV.filter((n) => !n.manageOnly || canManage).map((n) => ({
        key: n.path,
        icon: n.icon,
        label: n.label
      })),
    [canManage]
  );

  const current = useMemo(() => {
    // 开发者中心不在侧边栏菜单里（它是底部入口），单独给个标题
    if (location.pathname === '/developer') {
      return { key: 'developer', path: '/developer', label: '开发者中心', icon: null, desc: '复刻门户开发者页面' };
    }
    const exact = NAV.find((n) => n.path === location.pathname);
    if (exact) return exact;
    return NAV.find((n) => n.path !== '/' && location.pathname.startsWith(n.path));
  }, [location.pathname]);

  const selectedKey = current?.path || '/';
  const roles = user?.roles || [];

  const refreshAll = async () => {
    if (refreshing) return;
    setRefreshing(true);
    try {
      // 显式等待所有当前活跃查询真正重新请求完成，而不是只把缓存标脏。
      await qc.invalidateQueries();
    } finally {
      setRefreshing(false);
    }
  };

  return (
    <Layout className="ais-layout">
      <Sider
        width={216}
        collapsedWidth={0}
        collapsible
        collapsed={collapsed}
        onCollapse={setCollapsed}
        breakpoint="lg"
        trigger={null}
        className="ais-sider"
        style={{ height: '100vh' }}
      >
        <div className="ais-brand">
          <div className="ais-brand-logo">询</div>
          <div className="ais-brand-text">
            <b>自动询价系统</b>
            <span>Automatic Inquiry V1.0</span>
          </div>
        </div>

        <div className="ais-menu-wrap">
          <Menu
            theme="dark"
            mode="inline"
            selectedKeys={[selectedKey]}
            items={items}
            onClick={({ key }) => navigate(key)}
            style={{ borderInlineEnd: 'none', background: 'transparent', marginTop: 8 }}
          />
        </div>

        <div className="ais-sider-foot">
          <Link className="ais-dev-link" to="/developer">
            <code>{'</>'}</code> {cfg.data?.developer_name || 'IT · HZX-钟元'}
          </Link>
          <div className="ais-copy">{cfg.data?.copyright || '© IT · 汇挚鑫企业应用门户'}</div>
        </div>
      </Sider>

      <Layout className="ais-main" style={{ marginLeft: collapsed ? 0 : 216 }}>
        <Header className="ais-header">
          <Space size={12}>
            <span
              onClick={() => setCollapsed((v) => !v)}
              style={{ fontSize: 17, color: '#5a6b85', cursor: 'pointer', lineHeight: 1 }}
              title={collapsed ? '展开菜单' : '收起菜单'}
            >
              {collapsed ? <MenuUnfoldOutlined /> : <MenuFoldOutlined />}
            </span>
            <div>
              <span className="ais-header-title">{current?.label || '自动询价系统'}</span>
              <span className="ais-header-sub">{current?.desc || ''}</span>
            </div>
          </Space>
          <div style={{ display: 'flex', alignItems: 'center', gap: 14 }}>
            <Tooltip title="刷新当前页数据">
              <Button
                type="text"
                shape="circle"
                loading={refreshing}
                icon={<ReloadOutlined />}
                onClick={() => void refreshAll()}
                style={{ color: '#5a6b85' }}
                aria-label="刷新当前页数据"
              />
            </Tooltip>
            <Badge dot color="#18a058" offset={[-2, 26]}>
              <Dropdown
                menu={{
                  items: [
                    { key: 'who', label: <span style={{ color: '#93a0b5' }}>已通过企业门户登录</span>, disabled: true },
                    { type: 'divider' },
                    { key: 'logout', icon: <LogoutOutlined />, label: '退出登录', onClick: () => void logout() }
                  ]
                }}
              >
                <div style={{ display: 'flex', alignItems: 'center', gap: 8, cursor: 'pointer' }}>
                  <Avatar size={30} src={user?.avatar_url || undefined} icon={<UserOutlined />} style={{ background: '#3b6fe0' }} />
                  <div style={{ lineHeight: 1.2 }}>
                    <div style={{ fontSize: 13, fontWeight: 600 }}>{user?.display_name || user?.username}</div>
                    <div style={{ fontSize: 11, color: '#93a0b5' }}>
                      {roles
                        .map((r) => (ROLE_LABEL[r] || { text: r }).text)
                        .join(' / ') || '未分配角色'}
                    </div>
                  </div>
                </div>
              </Dropdown>
            </Badge>
            {roles.includes('admin') ? <Tag color="red">ADMIN</Tag> : null}
          </div>
        </Header>

        {newest ? (
          <Alert
            banner
            type="error"
            showIcon
            style={{ borderRadius: 0 }}
            message={
              <Space size={10} wrap>
                <b>{recentFailed.length} 个作业执行失败</b>
                <Typography.Text style={{ fontSize: 12.5 }}>
                  最新：{jobCN(newest.type)} · {fmtTime(newest.finished_at || newest.created_at)}
                  {newest.created_by ? ` · 发起人 ${newest.created_by}` : ''}
                </Typography.Text>
              </Space>
            }
            description={
              <Space direction="vertical" size={8} style={{ width: '100%' }}>
                <Typography.Text style={{ fontSize: 12.5 }} ellipsis={{ tooltip: newest.error || '' }}>
                  {String(newest.error || '（没有错误文本）').split('\n')[0]}
                </Typography.Text>
                <Space size={8} wrap>
                  <Button size="small" danger onClick={() => navigate(`/logs?job=${newest.id}`)}>
                    查看详情
                  </Button>
                  {recentFailed.length > 1 ? (
                    <Button size="small" onClick={() => navigate('/logs')}>
                      全部 {recentFailed.length} 条
                    </Button>
                  ) : null}
                  <Button size="small" type="text" onClick={() => dismissAlert(newest.id)}>
                    忽略
                  </Button>
                  <Typography.Text type="secondary" style={{ fontSize: 12 }}>
                    失败按配置同步推送到飞书群
                  </Typography.Text>
                </Space>
              </Space>
            }
          />
        ) : null}

        <Content className="ais-content">
          <Outlet />
          <Typography.Paragraph style={{ textAlign: 'center', color: '#a8b3c6', fontSize: 12, marginTop: 26, marginBottom: 0 }}>
            自动询价系统 · 接口层由 FastAPI 承载，浏览器动作经单队列串行下发给冻结的 Node 功能区块
          </Typography.Paragraph>
        </Content>
      </Layout>
    </Layout>
  );
}
