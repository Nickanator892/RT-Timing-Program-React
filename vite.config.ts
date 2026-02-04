import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import electron from 'vite-plugin-electron'

// https://vite.dev/config/
export default defineConfig({
  plugins: [
    react(),
    electron([
      {
        entry: 'electron/main.js',  // adjust path if your main.js is elsewhere
      },
      {
        entry: 'electron/preload.js',  // adjust path if your preload.js is elsewhere
      }
    ])
  ],
})