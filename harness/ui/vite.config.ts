import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

const harnessToken = process.env.HARNESS_TOKEN ?? ""
const harnessPort = process.env.HARNESS_PORT ?? "3777"

export default defineConfig({
  plugins: [react()],
  define: {
    'import.meta.env.VITE_HARNESS_TOKEN': JSON.stringify(harnessToken),
  },
  server: {
    host: '0.0.0.0',
    port: 5180,
    strictPort: true,
    allowedHosts: ['dotdot-mininuc.local'],
    proxy: {
      '/api': {
        target: `http://localhost:${harnessPort}`,
        headers: harnessToken ? { 'Authorization': `Bearer ${harnessToken}` } : {},
      },
      '/health': `http://localhost:${harnessPort}`,
    },
  },
})
