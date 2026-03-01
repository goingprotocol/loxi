import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

// https://vite.dev/config/
export default defineConfig({
  plugins: [react()],
  server: {
    host: true,
    proxy: {
      '/logistics': {
        target: 'http://127.0.0.1:8080',
        changeOrigin: true,
      },
      '/claim-task': {
        target: 'http://127.0.0.1:8080',
        changeOrigin: true,
      },
      '/workers': {
        target: 'http://127.0.0.1:8080',
        changeOrigin: true,
      },
      '/get-solution': {
        target: 'http://127.0.0.1:8080',
        changeOrigin: true,
      }
    }
  },
})
