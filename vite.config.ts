import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import electron from 'vite-plugin-electron'

// https://vite.dev/config/
export default defineConfig({
    define: {
      __APP_VERSION__: JSON.stringify(process.env.npm_package_version)
    },
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