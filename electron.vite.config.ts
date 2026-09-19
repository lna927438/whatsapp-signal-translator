import { defineConfig, externalizeDepsPlugin } from 'electron-vite'
import vue from '@vitejs/plugin-vue'
import { resolve } from 'path'

export default defineConfig({
  main: {
    plugins: [externalizeDepsPlugin()],
    build: {
      rollupOptions: {
        input: { index: resolve(__dirname, 'src/main/index.ts') }
      }
    }
  },
  preload: {
    plugins: [externalizeDepsPlugin()],
    build: {
      rollupOptions: {
        output: { format: 'cjs', entryFileNames: '[name].js' },
        input: {
          index: resolve(__dirname, 'src/preload/index.ts'),
          notice: resolve(__dirname, 'src/preload/notice.ts'),
          googleVoice: resolve(__dirname, 'src/preload/googleVoice.ts'),
          whatsapp: resolve(__dirname, 'src/preload/whatsapp.ts')
        }
      }
    }
  },
  renderer: {
    build: { rollupOptions: { input: { index: resolve(__dirname,'src/renderer/index.html'), notification: resolve(__dirname,'src/renderer/notification.html') } } },
    envPrefix: ['VITE_', 'RENDERER_VITE_'],
    resolve: { alias: { '@renderer': resolve(__dirname, 'src/renderer/src') } },
    plugins: [vue(), {
      name: 'hellodog-production-csp', apply: 'build',
      transformIndexHtml() { return [{ tag: 'meta', attrs: { 'http-equiv': 'Content-Security-Policy', content: "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob: https: hellodog-media:; media-src 'self' blob: hellodog-media:; connect-src 'self' blob: https: wss: hellodog-media:; font-src 'self' data:; object-src 'none'; base-uri 'none'; form-action 'none'; frame-src 'none'" }, injectTo: 'head-prepend' }] }
    }]
  }
})
