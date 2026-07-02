import { defineConfig } from 'vite'
import react from '@vitejs/react-plugin'

export default defineConfig({
  plugins: [react()],
  worker: {
    format: 'es' // 必须配置，让 Worker 支持现代 ES 语法
  }
})