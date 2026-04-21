import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

const harnessPort = process.env.HARNESS_PORT ?? "3777"
const viteHost = process.env.VITE_HOST ?? "0.0.0.0"

export default defineConfig({
  plugins: [react()],
  server: {
    host: viteHost,
    port: 5180,
    strictPort: true,
    allowedHosts: true,
    proxy: {
      '/api': `http://localhost:${harnessPort}`,
      '/health': `http://localhost:${harnessPort}`,
      '/ws': {
        target: `ws://localhost:${harnessPort}`,
        ws: true,
      },
    },
  },
})
