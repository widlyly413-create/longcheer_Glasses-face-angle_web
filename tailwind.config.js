/** @type {import('tailwindcss').Config} */
export default {
  content: [
    "./index.html",
    "./src/**/*.{js,ts,jsx,tsx}", // 👈 让 Tailwind 扫描 src 下所有的 tsx 文件
  ],
  theme: {
    extend: {},
  },
  plugins: [],
}