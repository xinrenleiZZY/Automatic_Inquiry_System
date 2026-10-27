import { useEffect, useMemo, useRef, useState } from 'react';
import {
  Alert,
  Badge,
  Button,
  Card,
  Col,
  Descriptions,
  Divider,
  Empty,
  Input,
  Modal,
  Row,
  Space,
  Table,
  Tag,
  Tooltip,
  Typography,
  message
} from 'antd';
import {
  ChromeOutlined,
  CloudUploadOutlined,
  LoginOutlined,
  KeyOutlined,
  PoweroffOutlined,
  ReloadOutlined,
  SafetyCertificateOutlined,
  ScanOutlined,
  SyncOutlined,
  ThunderboltOutlined
} from '@ant-design/icons';
import { useQuery, useQueryClient } from '@tanstack/react-query';

import { detailOf, get, post, put } from '../api/client';
import type {
  BrowserCheck,
  BrowserChromePath,
  BrowserLoginInfo,
  BrowserLoginPageState,
  BrowserStatus,
  BrowserStep,
  BrowserTab,
  Job
} from '../api/types';
import { useAuth } from '../auth/AuthContext';
import { fmtTime } from '../utils/format';

const LEVEL_COLOR: Record<string, string> = { ok: '#18a058', warn: '#e6a23c', bad: '#e5534b', idle: '#b0b9c9' };

const CHECK_HINT: Record<string, string> = {
  chrome: '调试实例（独立 profile）的进程与端口状态',
  cdp: 'Chrome 远程调试端口，通不了就什么都做不了',
  login: '有没有 1688 会员 cookie（unb / aui / _nk_ 这类）',
  session: '带着当前 cookie 请求工作台的实际结果 + 聊天页可读性',
  chat_page: '旺旺聊天页（def_cbu_web_im）是否已经打开',
  pages: '浏览器里各类标签页的数量',
  monitor: '常驻监听进程，负责收客户回复',
  queue: '串行队列，所有浏览器动作的唯一出口'
};

export default function BrowserStatusPage() {
  const qc = useQueryClient();
  const { canManage } = useAuth();
  const [busy, setBusy] = useState<string | null>(null);
  const [steps, setSteps] = useState<BrowserStep[] | null>(null);
  const [probeResult, setProbeResult] = useState<BrowserStatus | null>(null);
  /* null = 还没动过输入框，显示后端存的配置值 */
  const [pathInput, setPathInput] = useState<string | null>(null);
  const [acctInput, setAcctInput] = useState<string | null>(null);
  const [pwdInput, setPwdInput] = useState('');
  const [loginStage, setLoginStage] = useState<{ stage: string; detail: string } | null>(null);
  const [loginRunning, setLoginRunning] = useState(false);
  /* 登录成功后是否已经自动开过聊天页（防重复触发） */
  const autoOpenedChat = useRef(false);

  const loginInfo = useQuery({
    queryKey: ['browser-login-info'],
    queryFn: () => get<BrowserLoginInfo>('/api/browser/login-info')
  });

  const statusQ = useQuery({
    queryKey: ['browser-status'],
    queryFn: () => get<BrowserStatus>('/api/browser/status'),
    refetchInterval: 6000
  });

  useEffect(() => {
    const h = () => void qc.invalidateQueries({ queryKey: ['browser-status'] });
    window.addEventListener('ais:refresh', h);
    return () => window.removeEventListener('ais:refresh', h);
  }, [qc]);

  /* 检测项永远跟实时轮询走；「体检原始结果」单独留档，不会被下一次轮询刷掉 */
  const data = statusQ.data;
  const checks = data?.checks || [];
  const overall = data?.overall;
  const login = data?.login || {};
  const chromePath = data?.chrome_path;
  const pathValue = pathInput ?? chromePath?.configured ?? '';
  const acctValue = acctInput ?? loginInfo.data?.account ?? '';
  const probeLoginPage: BrowserLoginPageState | null | undefined = probeResult?.login_page;

  /** okText 传 null = 这次不弹统一的成功提示（调用方自己弹更具体的） */
  const run = async (key: string, fn: () => Promise<unknown>, okText: string | null) => {
    setBusy(key);
    setSteps(null);
    try {
      await fn();
      if (okText) message.success(okText);
      await qc.invalidateQueries({ queryKey: ['browser-status'] });
      await qc.invalidateQueries({ queryKey: ['system-health'] });
      await qc.invalidateQueries({ queryKey: ['flows'] });
    } catch (e) {
      message.error(detailOf(e));
    } finally {
      setBusy(null);
    }
  };

  const oneClickStart = () =>
    run(
      'start',
      async () => {
        const r = await post<{ steps: BrowserStep[]; snapshot: BrowserStatus }>('/api/browser/start', {
          chrome: true,
          monitor: true,
          queue: true
        });
        setSteps(r.steps);
        return r.snapshot;
      },
      '一键启动完成'
    );

  /** 强制重启浏览器：先清掉占用 6901 的进程与该 profile 的残留 Chrome，再起一个干净的 */
  const forceRestartChrome = () =>
    Modal.confirm({
      title: '强制重启浏览器',
      content:
        '会先关掉占用 6901 端口 / 属于本调试 profile 的 Chrome，再重新起一个干净的调试实例。' +
        '当前浏览器里打开的标签页会丢失（登录态存在 profile 里，不受影响）。',
      okText: '强制重启',
      okButtonProps: { danger: true },
      cancelText: '取消',
      onOk: () =>
        run(
          'chrome-force',
          async () => {
            const r = await post<{ result: { ok?: boolean; killed?: number[]; error?: string | null }; snapshot: BrowserStatus }>(
              '/api/browser/chrome/start?force=true'
            );
            return r.snapshot;
          },
          '已强制重启浏览器'
        )
    });

  const oneClickStop = () =>
    Modal.confirm({
      title: '一键停止',
      content:
        '会停止常驻监听并关掉 1688 调试实例（只关这个独立 profile 的 Chrome，日常浏览器不受影响）。' +
        '有作业正在执行时会被拒绝。',
      okText: '停止',
      okButtonProps: { danger: true },
      cancelText: '取消',
      onOk: () =>
        run(
          'stop',
          async () => {
            const r = await post<{ steps: BrowserStep[]; snapshot: BrowserStatus }>('/api/browser/stop', {
              chrome: true,
              monitor: true
            });
            setSteps(r.steps);
            return r.snapshot;
          },
          '一键停止完成'
        )
    });

  const probe = () =>
    run(
      'probe',
      async () => {
        const r = await post<BrowserStatus>('/api/browser/probe');
        setProbeResult(r);
        const v = r.verdict || {};
        message.info(`体检结论：${v.label || '未知'}${v.reason ? ` · ${v.reason}` : ''}`);
      },
      null
    );

  const openPage = (target: 'chat' | 'workbench') =>
    run(
      'open',
      async () => {
        const r = await post<{ job: { id: string } }>('/api/browser/open', { target });
        message.info(`已派发作业 ${r.job.id}（走队列执行，稍后刷新查看）`);
      },
      target === 'chat' ? '正在打开聊天页' : '正在打开工作台'
    );

  const flowToggle = (key: 'monitor' | 'queue', on: boolean) =>
    run(
      key + (on ? '-on' : '-off'),
      async () => {
        if (key === 'monitor') await post(on ? '/api/flows/monitor/start' : '/api/flows/monitor/stop');
        else await post(on ? '/api/flows/queue/start' : '/api/flows/queue/stop');
      },
      `${key === 'monitor' ? '常驻监听' : '串行队列'}已${on ? '启动' : '停止'}`
    );

  const saveChromePath = (next: string) =>
    run(
      'chrome-path',
      async () => {
        const r = await put<{ chrome_path: BrowserChromePath }>('/api/browser/chrome-path', { path: next });
        setPathInput(r.chrome_path?.configured ?? next);
      },
      next ? 'Chrome 路径已保存' : '已恢复自动检测'
    );

  const detectChrome = () =>
    run(
      'chrome-detect',
      async () => {
        const r = await get<{ chrome_path: BrowserChromePath }>('/api/browser/chrome-path', { refresh: true });
        setPathInput(null);
        message.info(
          r.chrome_path?.candidates?.length
            ? `检测到 ${r.chrome_path.candidates.length} 个 Chrome`
            : '没在默认位置找到 Chrome，请手动填写完整路径'
        );
      },
      null
    );

  /** 保存/清除 1688 凭证（密码留空 = 不改；清除按钮用 clear=true） */
  const saveLoginCred = (clear = false) =>
    run(
      'login-cred',
      async () => {
        const r = await put<BrowserLoginInfo>('/api/browser/login-credentials', {
          account: clear ? '' : acctValue.trim(),
          password: clear ? '' : (pwdInput ? pwdInput : null)
        });
        setAcctInput(r.account);
        setPwdInput('');
        await qc.invalidateQueries({ queryKey: ['browser-login-info'] });
      },
      clear ? '已清除保存的账号密码' : '凭证已保存（仅存本机 api.db）'
    );

  /** 一键登录：切页签 → 填表 → 点登录 → 自动拖一次滑块 → 处理保持登录 */
  const doLogin = async (mode: 'password' | 'qr' = 'password') => {
    setLoginRunning(true);
    setLoginStage(null);
    setSteps(null);
    try {
      const { job } = await post<{ job: Job }>('/api/browser/login', {
        keepLogin: true,
        waitMs: 6000,
        autoSolveCaptcha: true,
        captchaAttempts: 1,
        mode
      });
      let last = job;
      for (let i = 0; i < 60; i++) {
        await new Promise((r) => setTimeout(r, 2000));
        last = await get<Job>(`/api/jobs/${job.id}`);
        if (last.status !== 'queued' && last.status !== 'running') break;
      }
      const res = (last.result || {}) as { stage?: string; detail?: string };
      const detail = res.detail || (last.error ? String(last.error) : '') || `作业状态：${last.status}`;
      setLoginStage({ stage: res.stage || last.status, detail });
      if (last.status === 'failed') message.error(detail);
    } catch (e) {
      setLoginStage({ stage: 'error', detail: detailOf(e) });
      message.error(detailOf(e));
    } finally {
      setLoginRunning(false);
      await qc.invalidateQueries({ queryKey: ['browser-status'] });
      await qc.invalidateQueries({ queryKey: ['system-health'] });
    }
  };

  /* 看门狗：只等人工处理短信验证码或扫码；登录态一变绿就立刻收尾，
     不用人工再点「立即体检」。 */
  useEffect(() => {
    if (!loginStage) return;
    const waiting = ['captcha', 'sms_code', 'keep_login', 'submitted', 'qr_wait'];
    if (!waiting.includes(loginStage.stage)) return;
    if (!login?.logged_in) return;
    const chatOpen = Number(data?.counts?.chat || 0) > 0;
    setLoginStage({
      stage: 'logged_in',
      detail: chatOpen
        ? '登录态已生效，聊天页也开着，系统可以干活了。'
        : '登录态已生效，正在自动打开聊天页（监听接入后就能收客户回复）。'
    });
    message.success('1688 登录成功，登录态已生效');
    void qc.invalidateQueries({ queryKey: ['browser-status'] });
    /* 登录后如果聊天页没开，自动开一个 —— 否则监听一直在"没有可接入的聊天窗口"上空转 */
    if (!chatOpen && !autoOpenedChat.current) {
      autoOpenedChat.current = true;
      void post('/api/browser/open', { target: 'chat' })
        .then(() => message.info('已自动打开聊天页；监听接入后日志里会出现「已接入窗口」'))
        .catch(() => {
          autoOpenedChat.current = false;
        });
    }
  }, [login?.logged_in, loginStage, qc, data?.counts?.chat]);

  const columns = useMemo(
    () => [
      {
        title: '类别',
        dataIndex: 'kind_cn',
        width: 110,
        render: (v: string, r: BrowserTab) => (
          <Space size={6}>
            <Tag color={r.kind === 'chat' ? 'blue' : r.kind === 'results' ? 'geekblue' : 'default'}>{v}</Tag>
          </Space>
        )
      },
      {
        title: '标题 / 备注',
        dataIndex: 'title',
        render: (v: string, r: BrowserTab) => (
          <Space direction="vertical" size={0}>
            <Typography.Text style={{ fontSize: 12.5 }} ellipsis>
              {r.is_login_page ? '登录页（会话已失效）' : v || '-'}
            </Typography.Text>
            {r.imageId ? <Typography.Text type="secondary" style={{ fontSize: 11 }}>imageId {r.imageId}</Typography.Text> : null}
          </Space>
        )
      },
      {
        title: '地址',
        dataIndex: 'url',
        render: (v: string) => (
          <Typography.Text type="secondary" style={{ fontSize: 11.5 }} ellipsis={{ tooltip: v }}>
            {v}
          </Typography.Text>
        )
      }
    ],
    []
  );

  const checkIcon = (c: BrowserCheck) => <span className={`ais-dot ${c.level}`} />;

  return (
    <Space direction="vertical" size={16} style={{ width: '100%' }}>
      <Card
        className="ais-card"
        title={
          <Space>
            <ThunderboltOutlined />
            一键启停
          </Space>
        }
        extra={
          overall ? (
            <Tag color={overall.ok ? 'success' : 'error'} style={{ marginInlineEnd: 0 }}>
              {overall.label}
            </Tag>
          ) : null
        }
      >
        <Space size={12} wrap>
          <Button
            type="primary"
            size="large"
            icon={<ThunderboltOutlined />}
            disabled={!canManage}
            loading={busy === 'start'}
            onClick={oneClickStart}
          >
            一键启动
          </Button>
          <Button
            danger
            size="large"
            icon={<PoweroffOutlined />}
            disabled={!canManage}
            loading={busy === 'stop'}
            onClick={oneClickStop}
          >
            一键停止
          </Button>
          <Tooltip title="端口被占用 / 实例僵死时用：先清掉占用 6901 的进程与该 profile 的残留 Chrome，再起一个干净的">
            <Button
              size="large"
              icon={<ReloadOutlined />}
              disabled={!canManage}
              loading={busy === 'chrome-force'}
              onClick={forceRestartChrome}
            >
              强制重启浏览器
            </Button>
          </Tooltip>
          <Divider type="vertical" style={{ height: 26 }} />
          <Button icon={<SafetyCertificateOutlined />} loading={busy === 'probe'} onClick={probe}>
            立即体检
          </Button>
          <Button icon={<ChromeOutlined />} disabled={!canManage} loading={busy === 'open'} onClick={() => openPage('chat')}>
            打开聊天页
          </Button>
          <Button icon={<CloudUploadOutlined />} disabled={!canManage} loading={busy === 'open'} onClick={() => openPage('workbench')}>
            打开工作台
          </Button>
          <Button
            icon={<ReloadOutlined />}
            onClick={() => {
              setProbeResult(null);
              void qc.invalidateQueries({ queryKey: ['browser-status'] });
            }}
          >
            刷新
          </Button>
        </Space>
        {!canManage ? (
          <Typography.Text type="secondary" style={{ fontSize: 12 }}>
            启停浏览器 / 流程需要管理员或管理经理权限；普通用户可以查看检测结果。
          </Typography.Text>
        ) : null}

        <div style={{ marginTop: 12, fontSize: 12, color: '#8b98ad' }}>
          <div style={{ marginBottom: 6 }}>
            一键启动的顺序：<b>先看 6901 被谁占着</b> —— 占了但调试协议不响应（僵死实例）就先清掉再起；
            有本 profile 残留的 Chrome 也一并清（否则新进程会接管到旧实例上、端口永远不开）；健康实例不打断。
          </div>
          <Space size={18} wrap>
            <span>
              <Badge status={data?.monitor?.alive ? 'success' : 'default'} /> 常驻监听
              {data?.monitor?.alive ? ` 运行中（PID ${data.monitor.pid}）` : ' 未运行'}
            </span>
            <span>
              <Badge status={data?.queue?.running ? 'success' : 'default'} /> 串行队列
              {data?.queue?.running ? ` 运行中 · 深度 ${data.queue.depth}` : ' 已停止'}
            </span>
            <span>调试端口 {data?.target?.cdp_port ?? 6901}</span>
            <span style={{ wordBreak: 'break-all' }}>profile：{data?.target?.profile_dir || '-'}</span>
            {data?.at ? <span>检测时间 {fmtTime(data.at, false)}</span> : null}
          </Space>
        </div>
        <Space size={8} style={{ marginTop: 10 }} wrap>
          <Button size="small" disabled={!canManage} loading={busy === 'monitor-on'} onClick={() => flowToggle('monitor', true)}>
            启动监听
          </Button>
          <Button size="small" disabled={!canManage} loading={busy === 'monitor-off'} onClick={() => flowToggle('monitor', false)}>
            停止监听
          </Button>
          <Button size="small" disabled={!canManage} loading={busy === 'queue-on'} onClick={() => flowToggle('queue', true)}>
            启动队列
          </Button>
          <Button size="small" disabled={!canManage} loading={busy === 'queue-off'} onClick={() => flowToggle('queue', false)}>
            停止队列
          </Button>
        </Space>

        {steps?.length ? (
          <div style={{ marginTop: 12 }}>
            {steps.some((s) => !s.ok) ? (
              <Alert
                type="warning"
                showIcon
                style={{ marginBottom: 8 }}
                message={`有 ${steps.filter((s) => !s.ok).length} 步没成功，看下面的原因`}
                description={
                  <ul style={{ margin: 0, paddingLeft: 18, fontSize: 12.5 }}>
                    {steps.filter((s) => !s.ok).map((s) => (
                      <li key={s.step}>
                        <b>{s.step}</b>：{s.detail}
                      </li>
                    ))}
                  </ul>
                }
              />
            ) : null}
            {steps.map((s) => (
              <div key={s.step} className="ais-health-row">
                <span>
                  <span className={`ais-dot ${s.ok ? 'ok' : 'bad'}`} />
                  {s.step}
                </span>
                <span style={{ fontSize: 12, color: '#8b98ad' }}>{s.detail}</span>
              </div>
            ))}
          </div>
        ) : null}
      </Card>

      {overall && !overall.ok ? (
        <Alert
          type="error"
          showIcon
          message="当前状态不能正常干活"
          description={<span style={{ fontSize: 12.5 }}>{overall.reason}</span>}
        />
      ) : null}

      <Card
        title={
          <Space>
            <KeyOutlined />
            1688 登录（自动滑块）
          </Space>
        }
        extra={
          <Tag color={login.logged_in ? 'success' : 'error'} style={{ marginInlineEnd: 0 }}>
            {login.logged_in ? `已登录${login.account ? '：' + login.account : ''}` : '未登录'}
          </Tag>
        }
      >
        <Typography.Paragraph style={{ fontSize: 12.5, color: '#5a6b85', marginBottom: 10 }}>
          机器负责：切换到密码登录页签 → 填账号密码（<b>保存了凭证就以你保存的为准</b>；没保存才用页面上 Chrome 已填的）→ 点「登录」→ <b>自动拖动一次滑块</b> → 有「保持登录」弹窗就点「保持」。
          <br />
          滑块失败或出现短信验证码时，登录页会切到前台，你再人工完成。验证完成后什么都不用点：<b>这里检测到登录态生效就会自动确认</b>。
          <br />
          不想过滑块就用<b>「扫码登录」</b>：把登录页切到前台，手机扫一下，同样自动确认。
        </Typography.Paragraph>

        <Space.Compact style={{ width: '100%' }}>
          <Input
            value={acctValue}
            onChange={(e) => setAcctInput(e.target.value)}
            placeholder="1688 账号（旺旺号 / 子账号，如 playworld152:IT）"
            disabled={!canManage}
            allowClear
            style={{ maxWidth: 320 }}
          />
          <Input.Password
            value={pwdInput}
            onChange={(e) => setPwdInput(e.target.value)}
            placeholder={loginInfo.data?.has_password ? '密码已保存，留空 = 不修改' : '登录密码（不填也能用页面上已填好的）'}
            disabled={!canManage}
            style={{ maxWidth: 320 }}
          />
          <Button disabled={!canManage} loading={busy === 'login-cred'} onClick={() => saveLoginCred(false)}>
            保存凭证
          </Button>
          <Button disabled={!canManage} loading={busy === 'login-cred'} onClick={() => saveLoginCred(true)}>
            清除
          </Button>
        </Space.Compact>

        <Space size={10} style={{ marginTop: 12 }} wrap>
          <Button type="primary" icon={<LoginOutlined />} disabled={!canManage} loading={loginRunning} onClick={() => doLogin('password')}>
            一键登录
          </Button>
          <Button
            icon={<ScanOutlined />}
            disabled={!canManage}
            loading={loginRunning}
            onClick={() => doLogin('qr')}
            title="不填密码：把登录页切到前台，用手机扫二维码"
          >
            扫码登录
          </Button>
          <Typography.Text type="secondary" style={{ fontSize: 12 }}>
            {loginInfo.data?.has_password ? '已保存密码：' : '未保存密码：'}
            {loginInfo.data?.has_password ? '会用它填表' : '直接用登录页上已有的账号密码'}
          </Typography.Text>
        </Space>

        {loginStage ? (
          <Alert
            style={{ marginTop: 12 }}
            type={
              loginStage.stage === 'logged_in'
                ? 'success'
                : loginStage.stage === 'failed' || loginStage.stage === 'need_credentials'
                  ? 'warning'
                  : 'info'
            }
            showIcon
            message={`登录进度：${loginStage.stage}`}
            description={<span style={{ fontSize: 12.5 }}>{loginStage.detail}</span>}
          />
        ) : null}

        {probeLoginPage ? (
          <Alert
            style={{ marginTop: 12 }}
            type={probeLoginPage.verdict?.state === 'captcha' || probeLoginPage.verdict?.state === 'sms_code' ? 'warning' : 'info'}
            showIcon
            message="登录页当前状态"
            description={
              <span style={{ fontSize: 12.5 }}>
                {probeLoginPage.error || probeLoginPage.verdict?.detail || '—'}
                {probeLoginPage.user_filled ? ' · 账号已填' : ' · 账号未填'}
                {probeLoginPage.pass_filled ? ' · 密码已填' : ' · 密码未填'}
              </span>
            }
          />
        ) : null}

        <div style={{ marginTop: 10, fontSize: 12, color: '#8b98ad' }}>
          密码只存在本机 <code>data/api.db</code> 的 settings 表里，接口对外一律不回显（只回"有没有存"）；
          不填密码也能用 —— 只要 Chrome 帮你记住了，脚本就直接用页面上已有的值。
        </div>
      </Card>

      <Row gutter={[16, 16]}>
        <Col xs={24} lg={14}>
          <Card
            title={
              <Space>
                <SafetyCertificateOutlined />
                检测项
              </Space>
            }
            extra={<Typography.Text type="secondary" style={{ fontSize: 12 }}>点「立即体检」可验证聊天页可读性</Typography.Text>}
          >
            {checks.length ? (
              checks.map((c) => (
                <div className="ais-health-row" key={c.key}>
                  <Tooltip title={CHECK_HINT[c.key] || ''}>
                    <span>
                      {checkIcon(c)}
                      {c.label}
                    </span>
                  </Tooltip>
                  <span style={{ color: c.ok ? '#5a6b85' : LEVEL_COLOR[c.level] || '#8b98ad', fontSize: 12, maxWidth: '62%', textAlign: 'right' }}>
                    {c.detail}
                  </span>
                </div>
              ))
            ) : (
              <Empty description="还没有检测结果" image={Empty.PRESENTED_IMAGE_SIMPLE} />
            )}
          </Card>
        </Col>
        <Col xs={24} lg={10}>
          <Card
            title={
              <Space>
                <LoginOutlined />
                1688 账号与登录态
              </Space>
            }
            extra={
              <Tag color={login.logged_in ? 'success' : 'error'} style={{ marginInlineEnd: 0 }}>
                {login.logged_in ? '已登录' : '未登录'}
              </Tag>
            }
          >
            <Descriptions column={1} size="small" labelStyle={{ width: 96, color: '#8b98ad' }}>
              <Descriptions.Item label="登录账号">{login.account || login.member_id || '-'}</Descriptions.Item>
              <Descriptions.Item label="登录态">{login.validity || '-'}</Descriptions.Item>
              <Descriptions.Item label="会员 cookie">
                {(login.markers || []).length ? (login.markers || []).join(' / ') : <Typography.Text type="secondary">无</Typography.Text>}
                {(login.weak_markers || []).length ? (
                  <Typography.Text type="secondary" style={{ fontSize: 12 }}>
                    （另有登录页残留：{(login.weak_markers || []).join(' / ')}）
                  </Typography.Text>
                ) : null}
              </Descriptions.Item>
              <Descriptions.Item label="cookie 到期">
                {login.nearest_expiry ? fmtTime(login.nearest_expiry, false) : '-'}
              </Descriptions.Item>
              <Descriptions.Item label="服务端探测">
                {login.server?.ok ? (
                  <Space direction="vertical" size={0}>
                    <span>{login.server.logged_in ? '未跳转登录页（会话有效）' : '被重定向到登录页（会话已失效）'}</span>
                    <Typography.Text type="secondary" style={{ fontSize: 11.5, wordBreak: 'break-all' }}>
                      HTTP {login.server.status} · {login.server.final_url?.slice(0, 120)}
                    </Typography.Text>
                  </Space>
                ) : (
                  <Typography.Text type="secondary" style={{ fontSize: 12 }}>
                    探测不可用：{login.server?.error || '未执行'}
                  </Typography.Text>
                )}
              </Descriptions.Item>
              <Descriptions.Item label="判定">{data?.verdict?.reason || login.reason || '-'}</Descriptions.Item>
            </Descriptions>
            {data?.chat_note ? (
              <Typography.Text type="secondary" style={{ fontSize: 12 }}>
                {String(data.chat_note)}
              </Typography.Text>
            ) : null}
            {data?.chat && !(data.chat as { error?: string }).error ? (
              <Typography.Text type="secondary" style={{ fontSize: 12 }}>
                聊天页可读：会话 {(data.chat as { convs?: number }).convs ?? '-'} 条 ·
                登录名 {((data.chat as { nicks?: string[] }).nicks || []).join('/') || '-'}
              </Typography.Text>
            ) : null}
          </Card>
        </Col>
      </Row>

      <Card
        title={<Space><ChromeOutlined />浏览器里打开的页面（{data?.pages?.length ?? 0}）</Space>}
        styles={{ body: { paddingTop: 8 } }}
        extra={
          data?.counts ? (
            <Typography.Text type="secondary" style={{ fontSize: 12 }}>
              聊天 {data.counts.chat ?? 0} / 搜索 {data.counts.search ?? 0} / 结果 {data.counts.results ?? 0} / 其它{' '}
              {data.counts.other ?? 0}
              {data.counts.login_page ? ` · 登录页 ${data.counts.login_page}` : ''}
            </Typography.Text>
          ) : null
        }
      >
        {data?.pages?.length ? (
          <Table<BrowserTab>
            size="small"
            rowKey="id"
            pagination={false}
            dataSource={data.pages}
            columns={columns}
            scroll={{ x: 640 }}
          />
        ) : (
          <Empty description="浏览器里没有可用页面" image={Empty.PRESENTED_IMAGE_SIMPLE} />
        )}
      </Card>

      <Card
        title={
          <Space>
            <ChromeOutlined />
            Chrome 路径设置
          </Space>
        }
        extra={
          <Space size={6}>
            <Tag color={chromePath?.source === 'setting' ? 'blue' : chromePath?.source === 'env' ? 'gold' : 'default'}>
              {chromePath?.source_cn || '自动检测'}
            </Tag>
            {chromePath?.exists ? <Tag color="success">已找到</Tag> : <Tag color="error">未找到</Tag>}
          </Space>
        }
      >
        <Descriptions column={1} size="small" labelStyle={{ width: 110, color: '#8b98ad' }}>
          <Descriptions.Item label="当前生效">
            {chromePath?.resolved ? (
              <Typography.Text style={{ fontSize: 12 }} copyable>
                {chromePath.resolved}
              </Typography.Text>
            ) : (
              <Typography.Text type="danger" style={{ fontSize: 12 }}>
                没找到 chrome.exe ——「一键启动」会失败，请在下面填完整路径
              </Typography.Text>
            )}
          </Descriptions.Item>
          <Descriptions.Item label="调试 profile">
            <Typography.Text style={{ fontSize: 12 }} copyable>
              {chromePath?.profile_dir || '-'}
            </Typography.Text>
          </Descriptions.Item>
          {chromePath?.candidates?.length ? (
            <Descriptions.Item label="自动检测到">
              <Space direction="vertical" size={2}>
                {chromePath.candidates.map((c) => (
                  <Typography.Link key={c} style={{ fontSize: 12 }} onClick={() => setPathInput(c)}>
                    {c}
                  </Typography.Link>
                ))}
              </Space>
            </Descriptions.Item>
          ) : null}
        </Descriptions>

        <Space.Compact style={{ width: '100%', marginTop: 10 }}>
          <Input
            value={pathValue}
            onChange={(e) => setPathInput(e.target.value)}
            placeholder="留空 = 自动检测（Program Files / Program Files (x86) / LOCALAPPDATA）"
            disabled={!canManage}
            allowClear
          />
          <Button type="primary" disabled={!canManage} loading={busy === 'chrome-path'} onClick={() => saveChromePath(pathValue.trim())}>
            保存
          </Button>
          <Button disabled={!canManage} loading={busy === 'chrome-path'} onClick={() => saveChromePath('')}>
            恢复自动检测
          </Button>
          <Button disabled={!canManage} loading={busy === 'chrome-detect'} onClick={detectChrome}>
            重新检测
          </Button>
        </Space.Compact>
        <div style={{ marginTop: 8, fontSize: 12, color: '#8b98ad' }}>
          保存的是本机 chrome.exe 的完整路径（例如 <code>C:\Program Files\Google\Chrome\Application\chrome.exe</code>），
          只影响「一键启动」时拉起哪个浏览器，不会改动你日常使用的 Chrome。
          {chromePath?.env_value ? ` 环境变量 CHROME_EXE 当前是 ${chromePath.env_value}，页面设置优先。` : ''}
          {!canManage ? '（需要管理员/管理经理权限才能修改）' : ''}
        </div>
      </Card>

      {probeResult ? (
        <Card title={<Space><SyncOutlined />体检原始结果</Space>} styles={{ body: { paddingTop: 10 } }}>
          <Typography.Paragraph style={{ fontSize: 12, color: '#5a6b85', marginBottom: 8 }}>
            「立即体检」会读一次聊天页（只读）：核心文档在不在、会话列表能不能读出来、页面上有没有登录框。
          </Typography.Paragraph>
          <pre className="ais-json">{JSON.stringify({ verdict: probeResult.verdict, chat: probeResult.chat, login: { account: probeResult.login?.account, validity: probeResult.login?.validity } }, null, 2)}</pre>
        </Card>
      ) : null}
    </Space>
  );
}
