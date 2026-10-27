import type { ThemeConfig } from 'antd';

export const BRAND = {
  primary: '#3b6fe0',
  primaryDark: '#2b56b8',
  success: '#18a058',
  warning: '#e6a23c',
  danger: '#e5534b',
  violet: '#7a5af8',
  cyan: '#17a2b8'
};

export const themeConfig: ThemeConfig = {
  token: {
    colorPrimary: BRAND.primary,
    colorSuccess: BRAND.success,
    colorWarning: BRAND.warning,
    colorError: BRAND.danger,
    colorInfo: BRAND.primary,
    borderRadius: 10,
    fontSize: 14,
    fontFamily:
      '-apple-system, BlinkMacSystemFont, "Segoe UI", "PingFang SC", "Hiragino Sans GB", "Microsoft YaHei", "Helvetica Neue", Arial, sans-serif',
    colorBgLayout: '#f2f4f8'
  },
  components: {
    Layout: {
      siderBg: '#141c2e',
      headerBg: '#ffffff',
      headerHeight: 60,
      bodyBg: '#f2f4f8'
    },
    Menu: {
      darkItemBg: '#141c2e',
      darkSubMenuItemBg: '#0f1626',
      darkItemSelectedBg: BRAND.primary,
      darkItemHoverBg: '#1e2942',
      itemHeight: 42,
      itemMarginInline: 8,
      itemBorderRadius: 8
    },
    Card: {
      boxShadowTertiary: '0 1px 2px rgba(16,24,40,.04), 0 4px 12px rgba(16,24,40,.05)'
    },
    Table: {
      headerBg: '#f7f9fc',
      headerColor: '#42526b',
      rowHoverBg: '#f5f8ff',
      borderColor: '#eef1f6'
    },
    Statistic: { titleFontSize: 13 }
  }
};
