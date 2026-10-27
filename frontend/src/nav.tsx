import {
  ApartmentOutlined,
  AppstoreOutlined,
  BarChartOutlined,
  BookOutlined,
  ChromeOutlined,
  DashboardOutlined,
  FileSearchOutlined,
  MessageOutlined,
  PictureOutlined,
  ProfileOutlined,
  SlidersOutlined,
  SettingOutlined,
  TeamOutlined
} from '@ant-design/icons';
import type { ReactNode } from 'react';

export interface NavItem {
  key: string;
  path: string;
  label: string;
  icon: ReactNode;
  manageOnly?: boolean;
  desc?: string;
}

export const NAV: NavItem[] = [
  { key: 'dashboard', path: '/', label: '首页仪表盘', icon: <DashboardOutlined />, desc: '系统健康与业务总览' },
  { key: 'monitor', path: '/monitor', label: '状态监控', icon: <ChromeOutlined />, desc: '浏览器 / 1688 登录态体检与一键启停' },
  { key: 'campaigns', path: '/campaigns', label: '任务列表', icon: <ProfileOutlined />, desc: '比价任务的创建与推进' },
  { key: 'pricing-templates', path: '/pricing-templates', label: '比价配置方案', icon: <SlidersOutlined />, desc: '可复用的业务参数模板' },
  { key: 'task-center', path: '/task-center', label: '任务中心', icon: <ApartmentOutlined />, desc: '全自动大流程与小步骤状态' },
  { key: 'logs', path: '/logs', label: '日志中心', icon: <FileSearchOutlined />, desc: '排队中 / 执行中 / 历史任务与运行日志' },
  { key: 'compare', path: '/compare', label: '比价表', icon: <BarChartOutlined />, desc: '页面价与真实报价对照' },
  { key: 'customers', path: '/customers', label: '客户中心', icon: <MessageOutlined />, desc: '客户台账与往来记录' },
  { key: 'customer-admin', path: '/customer-admin', label: '客户管理', icon: <TeamOutlined />, manageOnly: true, desc: '白名单 / 黑名单 / 终止追踪' },
  { key: 'images', path: '/images', label: '图片库', icon: <PictureOutlined />, desc: '产品图片与短语绑定' },
  { key: 'phrases', path: '/phrases', label: '快捷短语', icon: <AppstoreOutlined />, desc: '文字 + 图片 + 产品关键词的询价话术' },
  { key: 'knowledge', path: '/knowledge', label: '知识库', icon: <BookOutlined />, desc: '固定回答 / 风险红线 / 报价解析规则' },
  { key: 'settings', path: '/settings', label: '参数设置', icon: <SettingOutlined />, manageOnly: true, desc: '询价数量 / 预期价格 / 护栏' }
];
