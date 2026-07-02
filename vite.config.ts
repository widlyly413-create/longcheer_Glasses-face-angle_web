import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  plugins: [react()],
  worker: {
    format: 'iife', // 经典 Worker 格式，支持 importScripts 加载 OpenCV.js
  }
});
