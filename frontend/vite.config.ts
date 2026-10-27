import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import path from 'node:path';

export default defineConfig({
  plugins: [react()],
  resolve: {
    alias: { '@': path.resolve(__dirname, 'src') }
  },
  build: {
    outDir: 'dist',
    emptyOutDir: true,
    chunkSizeWarningLimit: 1200,
    rollupOptions: {
      output: {
        manualChunks: {
          react: ['react', 'react-dom', 'react-router-dom'],
          antd: ['antd', '@ant-design/icons'],
          echarts: ['echarts'],
          query: ['@tanstack/react-query', 'axios', 'dayjs']
        }
      }
    }
  },
  server: {
    port: 6905,
    proxy: {
      // 后端端口跟随 .env 的 APP_PORT（默认 6900），避免开发代理指错端口
      '/api': { target: `http://127.0.0.1:${process.env.APP_PORT || '6900'}`, changeOrigin: true }
    }
  }
});
