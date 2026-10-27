import type { ReactNode } from 'react';

interface Props {
  icon: ReactNode;
  label: string;
  value: ReactNode;
  suffix?: string;
  color?: string;
  hint?: string;
}

export default function StatCard({ icon, label, value, suffix, color = '#3b6fe0', hint }: Props) {
  return (
    <div className="ais-card ais-stat">
      <div className="ais-stat-icon" style={{ background: `linear-gradient(135deg, ${color} 0%, ${color}b8 100%)` }}>
        {icon}
      </div>
      <div style={{ minWidth: 0 }}>
        <div className="ais-stat-value" style={{ color }}>
          {value}
          {suffix ? <span style={{ fontSize: 13, fontWeight: 500, marginLeft: 4 }}>{suffix}</span> : null}
        </div>
        <div className="ais-stat-label">{label}</div>
        {hint ? <div style={{ fontSize: 11, color: '#93a0b5', marginTop: 2 }}>{hint}</div> : null}
      </div>
    </div>
  );
}
