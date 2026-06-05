import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  plugins: [react()],
  worker: {
    format: 'es', // 保持 ES Module 格式，使 Worker 内部可以使用现代语法
  }
});