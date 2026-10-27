"use client";

/**
 * 开发者中心 — 复刻自 amazon_hzx_asin_image_system/frontend/developer.html
 * 门户原生页面，走 MainShell 布局（带侧边栏）
 */
import { useEffect, useRef } from "react";
import Link from "next/link";
import { ArrowLeft } from "lucide-react";

export default function DeveloperPage() {
  const titleRef = useRef<HTMLHeadingElement>(null);

  // 艺术标题逐字流光
  useEffect(() => {
    const el = titleRef.current;
    if (!el) return;
    const text = el.textContent || "";
    const colors = ["#22d3ee", "#34d399", "#fbbf24", "#a78bfa", "#f87171"];
    el.innerHTML = text
      .split("")
      .map(
        (ch, i) =>
          `<span class="artistic-char" style="animation-delay:${i * 0.35}s;color:${colors[i % colors.length]}">${ch === " " ? "&nbsp;" : ch}</span>`
      )
      .join("");
  }, []);

  const techs = [
    "Python", "FastAPI", "Next.js", "React", "TypeScript",
    "PostgreSQL", "Docker", "飞书API", "SQLAlchemy",
    "ECharts", "Pystray", "OpenClaw", "DeepSeek AI", "Nginx",
  ];

  return (
    <div className="space-y-5 animate-fade-in relative">
      <style>{`
        /* 科幻动效背景 */
        .dev-bg {
          position: fixed; inset: 0; z-index: 0; pointer-events: none; overflow: hidden;
        }
        .dev-bg-grid {
          position: absolute; inset: 0;
          background-image:
            linear-gradient(rgba(88,166,255,.03) 1px, transparent 1px),
            linear-gradient(90deg, rgba(88,166,255,.03) 1px, transparent 1px);
          background-size: 40px 40px;
        }
        .dev-bg-hud-tl, .dev-bg-hud-tr, .dev-bg-hud-bl, .dev-bg-hud-br {
          position: fixed; width: 30px; height: 30px; pointer-events: none; z-index: 1; opacity: 0.5;
        }
        .dev-bg-hud-tl { top: 12px; left: 274px; border-top: 1px solid var(--accent-primary); border-left: 1px solid var(--accent-primary); }
        .dev-bg-hud-tr { top: 12px; right: 12px; border-top: 1px solid var(--accent-primary); border-right: 1px solid var(--accent-primary); }
        .dev-bg-hud-bl { bottom: 12px; left: 274px; border-bottom: 1px solid var(--accent-primary); border-left: 1px solid var(--accent-primary); }
        .dev-bg-hud-br { bottom: 12px; right: 12px; border-bottom: 1px solid var(--accent-primary); border-right: 1px solid var(--accent-primary); }
        .dev-bg-scan-v {
          position: fixed; top: 0; left: 274px; width: 1px; height: 100vh;
          background: linear-gradient(180deg, transparent 0%, var(--accent-primary) 50%, transparent 100%);
          opacity: 0.12; z-index: 1; pointer-events: none;
          animation: devScanV 10s linear infinite;
        }
        @keyframes devScanV { 0% { left: 274px; } 100% { left: calc(100vw); } }
        .dev-bg-scan-h {
          position: fixed; top: 0; left: 274px; width: calc(100vw - 274px); height: 1px;
          background: linear-gradient(90deg, transparent 0%, var(--accent-primary) 50%, transparent 100%);
          opacity: 0.08; z-index: 1; pointer-events: none;
          animation: devScanH 8s linear infinite;
        }
        @keyframes devScanH { 0% { top: 0; } 100% { top: 100vh; } }
        .dev-bg-particles { position: absolute; inset: 0; }
        @keyframes devFloat { 0%, 100% { transform: translateY(0) scale(1); opacity: 0.3; } 50% { transform: translateY(-20px) scale(1.2); opacity: 0.6; } }
        .dev-particle {
          position: absolute; width: 2px; height: 2px; border-radius: 50%;
          background: var(--accent-primary); animation: devFloat 4s ease-in-out infinite;
        }

        .dev-watermark {
          position: relative; overflow: hidden;
          border-radius: 14px; border: 1px solid var(--border-color);
          background: var(--bg-surface); margin-bottom: 20px;
        }
        .dev-watermark .wm-bg {
          pointer-events: none; position: absolute; inset: 0;
          display: flex; align-items: center; overflow: hidden;
          opacity: 0.05; font-family: 'JetBrains Mono', 'Consolas', monospace;
        }
        .dev-watermark .wm-bg .inner { white-space: nowrap; animation: devMarquee 20s linear infinite; }
        .dev-watermark .wm-bg .word {
          font-size: 6rem; font-weight: 900; line-height: 1; color: var(--text-primary); user-select: none;
        }
        .dev-watermark .wm-bg .sep { color: var(--text-muted); margin: 0 4vw; }
        .dev-watermark .wm-content { position: relative; z-index: 10; padding: 24px 28px; }
        .dev-watermark .wm-content h1 { font-size: 24px; font-weight: 700; color: var(--text-primary); }
        .dev-watermark .wm-bar { margin-top: 8px; height: 2px; width: 64px; background: var(--accent-primary); border-radius: 2px; }
        @keyframes devMarquee { 0% { transform: translateX(0); } 100% { transform: translateX(-50%); } }

        .artistic-char {
          display: inline-block;
          background: linear-gradient(120deg, #22d3ee, #34d399, #fbbf24, #a78bfa, #f87171, #22d3ee);
          background-size: 300% 100%;
          -webkit-background-clip: text;
          background-clip: text;
          -webkit-text-fill-color: transparent;
          color: transparent !important;
          text-shadow: 0 0 18px rgba(34,211,238,.35);
          animation: artisticFlow 5s linear infinite;
          transition: transform .25s, filter .25s;
        }
        @keyframes artisticFlow { 0% { background-position: 0% 50%; } 100% { background-position: 300% 50%; } }

        .dev-avatar {
          width: 96px; height: 96px; border-radius: 50%;
          display: flex; align-items: center; justify-content: center;
          font-size: 40px; font-weight: 700; color: #fff;
          background: linear-gradient(135deg, #22d3ee, #3b82f6, #a78bfa);
          background-size: 200% 200%;
          animation: avatarGlow 3s ease-in-out infinite;
          box-shadow: 0 0 0 6px rgba(88,166,255,.15), 0 8px 24px rgba(34,211,238,.25);
          position: relative; z-index: 1;
        }
        @keyframes avatarGlow {
          0%, 100% { background-position: 0% 50%; box-shadow: 0 0 0 6px rgba(88,166,255,.15), 0 8px 24px rgba(34,211,238,.25); }
          50% { background-position: 100% 50%; box-shadow: 0 0 0 8px rgba(88,166,255,.3), 0 12px 32px rgba(167,139,250,.3); }
        }
        .dev-avatar-ring {
          position: absolute; inset: -8px; border-radius: 50%;
          border: 2px dashed var(--accent-primary);
          opacity: 0.3; animation: ringSpin 8s linear infinite;
        }
        @keyframes ringSpin { 0% { transform: rotate(0deg); } 100% { transform: rotate(360deg); } }

        .dev-link-btn {
          display: inline-flex; align-items: center; gap: 8px;
          padding: 10px 22px; border-radius: 10px; font-size: 14px; font-weight: 600;
          color: #fff; text-decoration: none; transition: all .3s; margin: 0 6px;
        }
        .dev-link-btn:hover { transform: translateY(-2px); }
        .dev-link-btn.gh { background: #24292e; }
        .dev-link-btn.gh:hover { background: #1a1f24; box-shadow: 0 4px 12px rgba(0,0,0,.3); }
        .dev-link-btn.blog { background: var(--accent-primary); }
        .dev-link-btn.blog:hover { filter: brightness(1.15); box-shadow: 0 4px 12px rgba(59,130,246,.3); }

        .dev-tech-tag {
          padding: 6px 16px; border-radius: 20px; font-size: 12px; font-weight: 500;
          background: var(--bg-surface-2); color: var(--text-secondary);
          border: 1px solid transparent; transition: all .3s;
        }
        .dev-tech-tag:hover {
          border-color: var(--accent-primary); color: var(--accent-primary);
          background: rgba(59,130,246,.1); transform: translateY(-1px);
        }

        .dev-blog-card {
          border-radius: 14px; overflow: hidden;
          background: var(--bg-surface); border: 1px solid var(--border-color);
        }
        .dev-blog-card .blog-header {
          padding: 14px 20px; display: flex; align-items: center; justify-content: space-between;
          border-bottom: 1px solid var(--border-color);
        }
        .dev-blog-card .blog-header h3 { font-size: 14px; font-weight: 600; color: var(--text-primary); }
        .dev-blog-card .blog-header a { font-size: 12px; color: var(--accent-primary); text-decoration: none; }
        .dev-blog-card .iframe-wrap { position: relative; width: 100%; height: 450px; overflow: hidden; }
        .dev-blog-card .iframe-wrap iframe {
          width: 133.333%; height: 600px; border: none; display: block;
          transform: scale(0.75); transform-origin: top left;
        }
      `}</style>

      {/* 科幻动效背景 */}
      <div className="dev-bg">
        <div className="dev-bg-grid" />
        <div className="dev-bg-particles">
          {Array.from({ length: 20 }, (_, i) => (
            <div
              key={i}
              className="dev-particle"
              style={{
                left: `${Math.random() * 100}%`,
                top: `${Math.random() * 100}%`,
                animationDelay: `${Math.random() * 4}s`,
                animationDuration: `${3 + Math.random() * 5}s`,
              }}
            />
          ))}
        </div>
      </div>
      <div className="dev-bg-hud-tl" />
      <div className="dev-bg-hud-tr" />
      <div className="dev-bg-hud-bl" />
      <div className="dev-bg-hud-br" />
      <div className="dev-bg-scan-v" />
      <div className="dev-bg-scan-h" />

      {/* 水印横幅 */}
      <div className="dev-watermark">
        <div className="wm-bg">
          <div className="inner">
            <span className="word">HZX_DEVELOPER<span className="sep">◆</span>HZX_DEVELOPER<span className="sep">◆</span>HZX_DEVELOPER<span className="sep">◆</span></span>
            <span className="word">HZX_DEVELOPER<span className="sep">◆</span>HZX_DEVELOPER<span className="sep">◆</span>HZX_DEVELOPER<span className="sep">◆</span></span>
          </div>
        </div>
        <div className="wm-content">
          <h1 ref={titleRef}>个人开发者中心</h1>
          <div className="wm-bar" />
        </div>
      </div>

      {/* 个人信息卡片 */}
      <div className="panel hud p-10 text-center space-y-4">
        <div className="relative inline-block mb-4">
          <div className="dev-avatar-ring" />
          <img
            src="/avatar.png"
            alt="开发者头像"
            className="dev-avatar object-cover"
          />
        </div>
        <div className="text-[22px] font-bold" style={{ color: "var(--text-primary)" }}>
          IT-钟
        </div>
        <div className="text-sm" style={{ color: "var(--text-muted)" }}>
          全栈开发者 / 系统架构师 / 自动化专家
        </div>
        <div className="text-xs" style={{ color: "var(--text-muted)", opacity: 0.7 }}>
          汇挚鑫企业应用门户 V1.0 · 📞 18072740843
        </div>

        <div className="flex justify-center flex-wrap pt-2">
          <a
            href="https://github.com/xinrenleiZZY"
            target="_blank"
            rel="noopener noreferrer"
            className="dev-link-btn gh"
          >
            <svg viewBox="0 0 24 24" width="18" height="18" fill="currentColor">
              <path d="M12 0C5.37 0 0 5.37 0 12c0 5.31 3.435 9.795 8.205 11.385.6.105.825-.255.825-.57 0-.285-.015-1.23-.015-2.235-3.015.555-3.795-.735-4.035-1.41-.135-.345-.72-1.41-1.23-1.695-.42-.225-1.02-.78-.015-.795.945-.015 1.62.87 1.845 1.23 1.08 1.815 2.805 1.305 3.495.99.105-.78.42-1.305.765-1.605-2.67-.3-5.46-1.335-5.46-5.925 0-1.305.465-2.385 1.23-3.225-.12-.3-.54-1.53.12-3.18 0 0 1.005-.315 3.3 1.23.96-.27 1.98-.405 3-.405s2.04.135 3 .405c2.295-1.56 3.3-1.23 3.3-1.23.66 1.65.24 2.88.12 3.18.765.84 1.23 1.905 1.23 3.225 0 4.605-2.805 5.625-5.475 5.925.435.375.81 1.095.81 2.22 0 1.605-.015 2.895-.015 3.3 0 .315.225.69.825.57A12.02 12.02 0 0024 12c0-6.63-5.37-12-12-12z" />
            </svg>
            GitHub
          </a>
          <a
            href="https://www.juxingspacestation.top/"
            target="_blank"
            rel="noopener noreferrer"
            className="dev-link-btn blog"
          >
            <svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" strokeWidth="2">
              <circle cx="12" cy="12" r="10" />
              <path d="M2 12h20M12 2a15.3 15.3 0 014 10 15.3 15.3 0 01-4 10 15.3 15.3 0 01-4-10 15.3 15.3 0 014-10z" />
            </svg>
            个人博客
          </a>
        </div>

        {/* 技术栈 */}
        <div className="pt-2">
          <h3 className="text-sm font-semibold mb-3" style={{ color: "var(--text-primary)" }}>技术栈</h3>
          <div className="flex flex-wrap justify-center gap-2">
            {techs.map((t) => (
              <span key={t} className="dev-tech-tag">{t}</span>
            ))}
          </div>
        </div>
      </div>

      {/* 博客内嵌 */}
      <div className="dev-blog-card">
        <div className="blog-header">
          <h3>🌐 IT-钟的个人博客</h3>
          <a href="https://www.juxingspacestation.top/" target="_blank" rel="noopener noreferrer">
            新窗口打开 →
          </a>
        </div>
        <div className="iframe-wrap">
          <iframe
            src="https://www.juxingspacestation.top"
            title="IT-钟的个人博客"
            loading="lazy"
            sandbox="allow-scripts allow-same-origin allow-forms allow-popups"
          />
        </div>
      </div>

      {/* 返回 */}
      <div className="text-center">
        <Link
          href="/dashboard"
          className="inline-flex items-center gap-1 text-sm hover:opacity-80 transition-opacity"
          style={{ color: "var(--accent-primary)" }}
        >
          <ArrowLeft className="w-4 h-4" />
          返回仪表盘
        </Link>
      </div>
    </div>
  );
}