import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import { fileURLToPath, URL } from 'node:url'

export default defineConfig({
  plugins: [react()],
  resolve: {
    alias: {
      '@': fileURLToPath(new URL('./src', import.meta.url)),
    },
  },
  build: {
    rollupOptions: {
      input: {
        index: fileURLToPath(new URL('./index.html', import.meta.url)),
        editor: fileURLToPath(new URL('./editor.html', import.meta.url)),
        runtime: fileURLToPath(new URL('./runtime.html', import.meta.url)),
      },
    },
  },
  server: {
    port: 5173,
    proxy: {
      '/api': { target: 'http://localhost:8790', changeOrigin: true },
      '/assets': { target: 'http://localhost:8790', changeOrigin: true },
      '/plugins': { target: 'http://localhost:8790', changeOrigin: true },
      '/pyodide': { target: 'http://localhost:8790', changeOrigin: true },
      '/ws': { target: 'ws://localhost:8790', ws: true },
    },
  },
})
