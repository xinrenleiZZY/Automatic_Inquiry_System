import { Navigate, Route, Routes, useLocation } from 'react-router-dom';
import { Spin } from 'antd';

import AppLayout from './components/AppLayout';
import { useAuth } from './auth/AuthContext';
import Login from './pages/Login';
import Dashboard from './pages/Dashboard';
import BrowserStatusPage from './pages/BrowserStatus';
import Campaigns from './pages/Campaigns';
import PricingTemplates from './pages/PricingTemplates';
import TaskCenter from './pages/TaskCenter';
import Compare from './pages/Compare';
import Logs from './pages/Logs';
import Customers from './pages/Customers';
import CustomerAdmin from './pages/CustomerAdmin';
import SettingsPage from './pages/Settings';
import Images from './pages/Images';
import Phrases from './pages/Phrases';
import KnowledgeBase from './pages/KnowledgeBase';
import Developer from './pages/Developer';

function RequireAuth({ children }: { children: JSX.Element }) {
  const { user, loading } = useAuth();
  const location = useLocation();

  if (loading) {
    return (
      <div style={{ height: '100vh', display: 'grid', placeItems: 'center' }}>
        <Spin size="large" tip="正在确认登录状态…">
          <div style={{ padding: 40 }} />
        </Spin>
      </div>
    );
  }
  if (!user) {
    const back = encodeURIComponent(location.pathname + location.search);
    return <Navigate to={`/login?redirect=${back}`} replace />;
  }
  return children;
}

export default function App() {
  return (
    <Routes>
      <Route path="/login" element={<Login />} />
      <Route
        element={
          <RequireAuth>
            <AppLayout />
          </RequireAuth>
        }
      >
        <Route path="/" element={<Dashboard />} />
        <Route path="/monitor" element={<BrowserStatusPage />} />
        <Route path="/campaigns" element={<Campaigns />} />
        <Route path="/pricing-templates" element={<PricingTemplates />} />
        <Route path="/task-center" element={<TaskCenter />} />
        <Route path="/compare" element={<Compare />} />
        <Route path="/logs" element={<Logs />} />
        <Route path="/customers" element={<Customers />} />
        <Route path="/customer-admin" element={<CustomerAdmin />} />
        <Route path="/images" element={<Images />} />
        <Route path="/phrases" element={<Phrases />} />
        <Route path="/knowledge" element={<KnowledgeBase />} />
        <Route path="/settings" element={<SettingsPage />} />
        <Route path="/developer" element={<Developer />} />
      </Route>
      <Route path="*" element={<Navigate to="/" replace />} />
    </Routes>
  );
}
