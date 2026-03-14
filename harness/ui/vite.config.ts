import { readFileSync } from 'fs'
import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

const harnessPort = process.env.HARNESS_PORT ?? "3777"
const tlsCertPath = process.env.HARNESS_TLS_CERT
const tlsKeyPath = process.env.HARNESS_TLS_KEY

export default defineConfig({
  plugins: [react()],
  server: {
    host: '0.0.0.0',
    port: 5180,
    strictPort: true,
    allowedHosts: ['dotdot-mininuc.local', 'REDACTED', '.ts.net'],
    https: tlsCertPath && tlsKeyPath
      ? {
          cert: readFileSync(tlsCertPath),
          key: readFileSync(tlsKeyPath),
        }
      : undefined,
    proxy: {
      '/api': `http://localhost:${harnessPort}`,
      '/health': `http://localhost:${harnessPort}`,
    },
  },
})
