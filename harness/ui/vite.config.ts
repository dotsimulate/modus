import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

const harnessPort = process.env.HARNESS_PORT ?? "3777"

export default defineConfig({
  plugins: [react()],
  server: {
    host: '0.0.0.0',
    port: 5180,
    strictPort: true,
    allowedHosts: ['dotdot-mininuc.local', 'REDACTED'],
    proxy: {
      '/api': `http://localhost:${harnessPort}`,
      '/health': `http://localhost:${harnessPort}`,
    },
  },
})
