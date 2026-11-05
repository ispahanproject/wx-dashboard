import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

import { cloudflare } from "@cloudflare/vite-plugin";

export default defineConfig(({ command }) => ({
  base: '/wx-dashboard/',
  // Cloudflare プラグインはビルド時のみ（dev では /wx-dashboard/ が 404 になるため）
  plugins: [react(), ...(command === 'build' ? [cloudflare()] : [])],
  server: {
    proxy: {
      '/awc-api': {
        target: 'https://wx-awc-proxy.trinity-funkyboy.workers.dev',
        changeOrigin: true,
        rewrite: (path) => path.replace(/^\/awc-api/, ''),
      },
    },
  },
}))
