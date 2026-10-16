import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    proxy: {
      '/api': { target: 'http://localhost:8790', changeOrigin: true },
      '/assets': { target: 'http://localhost:8790', changeOrigin: true },
      '/ws': { target: 'ws://localhost:8790', ws: true },
    },
  },
})
