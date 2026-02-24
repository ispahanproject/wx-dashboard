import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

export default defineConfig({
  base: '/wx-dashboard/',
  plugins: [react()],
  server: {
    proxy: {
      '/awc-api': {
        target: 'https://aviationweather.gov',
        changeOrigin: true,
        rewrite: (path) => path.replace(/^\/awc-api/, ''),
      },
    },
  },
})
