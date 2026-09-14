import { defineConfig, loadEnv } from 'vite'
import vue from '@vitejs/plugin-vue'

export default defineConfig(({ mode, command }) => {
  const shared = loadEnv(mode === 'admin-live' ? 'development' : mode, '..', 'VITE_')
  const local = loadEnv(mode, '.', 'VITE_')
  const publicConfig = { ...shared, ...local }
  if (command === 'build' && mode !== 'admin-local' && (!publicConfig.VITE_SUPABASE_URL || !publicConfig.VITE_SUPABASE_PUBLISHABLE_KEY)) {
    throw new Error('Public login configuration is required for a release build.')
  }
  return {
  plugins: [vue()],
  ...(mode !== 'admin-local' ? { define: {
    'import.meta.env.VITE_SUPABASE_URL': JSON.stringify(publicConfig.VITE_SUPABASE_URL||''),
    'import.meta.env.VITE_SUPABASE_PUBLISHABLE_KEY': JSON.stringify(publicConfig.VITE_SUPABASE_PUBLISHABLE_KEY||''),
    'import.meta.env.VITE_API_BASE_URL': JSON.stringify('https://api.hellodog.net')
  }} : {}),
  // Local admin preview must never inherit production account credentials.
  ...(mode === 'admin-local' ? { define: {
    'import.meta.env.VITE_SUPABASE_URL': JSON.stringify(''),
    'import.meta.env.VITE_SUPABASE_PUBLISHABLE_KEY': JSON.stringify(''),
    'import.meta.env.VITE_API_BASE_URL': JSON.stringify('')
  } } : {}),
  build: {
    outDir: 'dist',
    sourcemap: false
  }
  }
})
