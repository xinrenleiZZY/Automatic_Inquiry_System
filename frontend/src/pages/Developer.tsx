import { useMemo, useState } from 'react';
import { ArrowLeftOutlined } from '@ant-design/icons';
import { Link } from 'react-router-dom';

import { useAuth } from '../auth/AuthContext';

/**
 * 开发者中心 —— 复刻门户 developer 页面
 * （原文件：frontend/src/developer/page.tsx，Next.js + Tailwind 版本，
 *   这里按本项目的 React + 全局样式重写，视觉与结构保持一致）
 */

const TITLE = '个人开发者中心';
const TITLE_COLORS = ['#22d3ee', '#34d399', '#fbbf24', '#a78bfa', '#f87171'];

const TECHS = [
  'Python',
  'FastAPI',
  'Next.js',
  'React',
  'TypeScript',
  'PostgreSQL',
  'Docker',
  '飞书API',
  'SQLAlchemy',
  'ECharts',
  'Pystray',
  'OpenClaw',
  'DeepSeek AI',
  'Nginx'
];

const GITHUB_URL = 'https://github.com/xinrenleiZZY';
const BLOG_URL = 'https://www.juxingspacestation.top/';

/* 开发者头像：直接取图片库里的 developer.png（tools/qianniu/image/developer.png）
   —— 换掉那个文件就等于换头像，不用改代码。取不到时退回登录用户头像，再退回渐变色。 */
const DEV_AVATAR_URL = '/api/library/file?path=' + encodeURIComponent('developer.png');

export default function Developer() {
  const { user } = useAuth();
  const [avatarFailed, setAvatarFailed] = useState(false);

  /* 粒子位置固定住，避免每次渲染都跳一下 */
  const particles = useMemo(
    () =>
      Array.from({ length: 20 }, () => ({
        left: `${Math.random() * 100}%`,
        top: `${Math.random() * 100}%`,
        delay: `${Math.random() * 4}s`,
        duration: `${3 + Math.random() * 5}s`
      })),
    []
  );

  const avatarSrc = avatarFailed ? user?.avatar_url || null : DEV_AVATAR_URL;

  return (
    <div className="dev-page">
      {/* 科幻动效背景 */}
      <div className="dev-bg">
        <div className="dev-bg-grid" />
        {particles.map((p, i) => (
          <div
            key={i}
            className="dev-particle"
            style={{ left: p.left, top: p.top, animationDelay: p.delay, animationDuration: p.duration }}
          />
        ))}
      </div>
      <div className="dev-bg-hud-tl" />
      <div className="dev-bg-hud-tr" />
      <div className="dev-bg-hud-bl" />
      <div className="dev-bg-hud-br" />
      <div className="dev-bg-scan-v" />
      <div className="dev-bg-scan-h" />

      {/* 水印横幅 + 逐字流光标题 */}
      <div className="dev-watermark">
        <div className="wm-bg">
          <div className="inner">
            {[0, 1].map((k) => (
              <span className="word" key={k}>
                HZX_DEVELOPER<span className="sep">◆</span>
                HZX_DEVELOPER<span className="sep">◆</span>
                HZX_DEVELOPER<span className="sep">◆</span>
              </span>
            ))}
          </div>
        </div>
        <div className="wm-content">
          <h1>
            {TITLE.split('').map((ch, i) => (
              <span
                key={i}
                className="artistic-char"
                style={{ animationDelay: `${i * 0.35}s`, color: TITLE_COLORS[i % TITLE_COLORS.length] }}
              >
                {ch}
              </span>
            ))}
          </h1>
          <div className="wm-bar" />
        </div>
      </div>

      {/* 个人信息卡片 */}
      <div className="dev-card">
        <div className="dev-avatar-wrap">
          <div className="dev-avatar-ring" />
          {avatarSrc ? (
            <img className="dev-avatar" src={avatarSrc} alt="开发者头像" onError={() => setAvatarFailed(true)} />
          ) : (
            <div className="dev-avatar">钟</div>
          )}
        </div>

        <div style={{ fontSize: 22, fontWeight: 700, color: 'var(--text-primary)' }}>IT-钟</div>
        <div style={{ fontSize: 13, color: 'var(--text-muted)', marginTop: 6 }}>
          全栈开发者 / 系统架构师 / 自动化专家
        </div>
        <div style={{ fontSize: 12, color: 'var(--text-muted)', opacity: 0.7, marginTop: 6 }}>
          汇挚鑫企业应用门户 V1.0 · 📞 18072740843
        </div>

        <div style={{ display: 'flex', justifyContent: 'center', flexWrap: 'wrap', gap: 12, paddingTop: 18 }}>
          <a href={GITHUB_URL} target="_blank" rel="noopener noreferrer" className="dev-link-btn gh">
            <svg viewBox="0 0 24 24" width="18" height="18" fill="currentColor">
              <path d="M12 0C5.37 0 0 5.37 0 12c0 5.31 3.435 9.795 8.205 11.385.6.105.825-.255.825-.57 0-.285-.015-1.23-.015-2.235-3.015.555-3.795-.735-4.035-1.41-.135-.345-.72-1.41-1.23-1.695-.42-.225-1.02-.78-.015-.795.945-.015 1.62.87 1.845 1.23 1.08 1.815 2.805 1.305 3.495.99.105-.78.42-1.305.765-1.605-2.67-.3-5.46-1.335-5.46-5.925 0-1.305.465-2.385 1.23-3.225-.12-.3-.54-1.53.12-3.18 0 0 1.005-.315 3.3 1.23.96-.27 1.98-.405 3-.405s2.04.135 3 .405c2.295-1.56 3.3-1.23 3.3-1.23.66 1.65.24 2.88.12 3.18.765.84 1.23 1.905 1.23 3.225 0 4.605-2.805 5.625-5.475 5.925.435.375.81 1.095.81 2.22 0 1.605-.015 2.895-.015 3.3 0 .315.225.69.825.57A12.02 12.02 0 0024 12c0-6.63-5.37-12-12-12z" />
            </svg>
            GitHub
          </a>
          <a href={BLOG_URL} target="_blank" rel="noopener noreferrer" className="dev-link-btn blog">
            <svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" strokeWidth="2">
              <circle cx="12" cy="12" r="10" />
              <path d="M2 12h20M12 2a15.3 15.3 0 014 10 15.3 15.3 0 01-4 10 15.3 15.3 0 01-4-10 15.3 15.3 0 014-10z" />
            </svg>
            个人博客
          </a>
        </div>

        {/* 技术栈 */}
        <div style={{ paddingTop: 20 }}>
          <h3 style={{ fontSize: 13, fontWeight: 600, marginBottom: 12, color: 'var(--text-primary)' }}>技术栈</h3>
          <div style={{ display: 'flex', flexWrap: 'wrap', justifyContent: 'center', gap: 8 }}>
            {TECHS.map((t) => (
              <span key={t} className="dev-tech-tag">
                {t}
              </span>
            ))}
          </div>
        </div>
      </div>

      {/* 博客内嵌 */}
      <div className="dev-blog-card">
        <div className="blog-header">
          <h3>🌐 IT-钟的个人博客</h3>
          <a href={BLOG_URL} target="_blank" rel="noopener noreferrer">
            新窗口打开 →
          </a>
        </div>
        <div className="iframe-wrap">
          <iframe
            src={BLOG_URL}
            title="IT-钟的个人博客"
            loading="lazy"
            sandbox="allow-scripts allow-same-origin allow-forms allow-popups"
          />
        </div>
      </div>

      {/* 返回 */}
      <div style={{ textAlign: 'center' }}>
        <Link to="/" className="dev-back-link">
          <ArrowLeftOutlined /> 返回仪表盘
        </Link>
      </div>
    </div>
  );
}
