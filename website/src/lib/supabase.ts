import { createClient } from '@supabase/supabase-js'

const url = String(import.meta.env.VITE_SUPABASE_URL || '').trim()
const key = String(import.meta.env.VITE_SUPABASE_PUBLISHABLE_KEY || '').trim()

export const supabaseConfigured = Boolean(url && key)
export const supabase = supabaseConfigured ? createClient(url, key, {
  auth: {
    persistSession: true,
    autoRefreshToken: true,
    detectSessionInUrl: true
  }
}) : null

export function requireSupabase() {
  if (!supabase) throw new Error('网站尚未配置 Supabase。')
  return supabase
}

export const downloadBase = String(import.meta.env.VITE_DOWNLOAD_BASE_URL || 'https://pub-7bc571c7ff594db39de0109887d148f1.r2.dev').replace(/\/$/, '')
