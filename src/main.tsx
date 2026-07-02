import React from 'react';
import { createRoot } from 'react-dom/client';
import App from './app';
import './index.css'; // 如果你有全局 CSS，例如 Tailwind 的入口

const rootElement = document.getElementById('root');

if (rootElement) {
  const root = createRoot(rootElement);
  root.render(
    <React.StrictMode>
      <App />
    </React.StrictMode>
  );
}