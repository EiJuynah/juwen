import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const BRIDGE_PORT = process.env.PORT || 5178;

export default defineConfig({
  // 必须用绝对路径：root 若写相对路径会按 process.cwd() 解析，
  // 而 dev:web 是从项目根执行的，root 就会指错目录导致 404
  root: here,
  plugins: [react()],
  server: {
    port: Number(process.env.WEB_PORT) || 5179,
    strictPort: true,
    // 前端 5179 → 桥接层 5178。必须走代理：
    // 浏览器同源策略下 fetch 直连 5178 会被 CORS 拦掉
    proxy: {
      '/api': {
        target: `http://127.0.0.1:${BRIDGE_PORT}`,
        changeOrigin: false,
        // SSE 必须关闭代理缓冲，否则流式会被攒成一次性返回
        configure: (proxy) => {
          proxy.on('proxyRes', (proxyRes) => {
            if (String(proxyRes.headers['content-type'] || '').includes('text/event-stream')) {
              proxyRes.headers['x-accel-buffering'] = 'no';
            }
          });
        },
      },
    },
  },
  build: {
    outDir: path.join(here, '..', 'dist'),
    emptyOutDir: true,
  },
});
