import { defineConfig } from 'vite'
import vue from '@vitejs/plugin-vue'
import tailwindcss from '@tailwindcss/vite'
import { version } from './package.json'

const host = process.env.TAURI_DEV_HOST

export default defineConfig({
  define: {
    __APP_VERSION__: JSON.stringify(version),
  },
  plugins: [vue(), tailwindcss()],
  optimizeDeps: {
    entries: ['index.html', 'index-mobile.html'],
  },
  // 多入口：index.html = 桌面端 / index-mobile.html = 手机遥控端
  build: {
    target: 'esnext',
    modulePreload: { polyfill: false },
    reportCompressedSize: false,
    rolldownOptions: {
      input: {
        main: 'index.html',
        mobile: 'index-mobile.html',
      },
      output: {
        codeSplitting: {
          groups: [
            {
              name: 'vue',
              test: /[\\/]node_modules[\\/]vue[\\/]/,
            },
          ],
        },
      },
    },
  },
  clearScreen: false,
  server: {
    port: 1420,
    strictPort: true,
    host: host || false,
    hmr: host ? { protocol: 'ws', host, port: 1421 } : undefined,
    watch: {
      ignored: ['**/src-tauri/**'],
    },
  },
})
