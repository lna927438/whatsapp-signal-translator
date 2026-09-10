import { createClient, type SupabaseClient } from '@supabase/supabase-js'

const supabaseUrl = String(import.meta.env.VITE_SUPABASE_URL || '').trim()
const supabasePublishableKey = String(import.meta.env.VITE_SUPABASE_PUBLISHABLE_KEY || '').trim()

export const supabaseConfigured = Boolean(supabaseUrl && supabasePublishableKey)

export const supabase: SupabaseClient | null = supabaseConfigured
  ? createClient(supabaseUrl, supabasePublishableKey, {
      auth: {
        persistSession: true,
        autoRefreshToken: true,
        detectSessionInUrl: false
      }
    })
  : null

export function requireSupabase(): SupabaseClient {
  if (!supabase) {
    throw new Error('在线登录尚未配置。请设置 VITE_SUPABASE_URL 和 VITE_SUPABASE_PUBLISHABLE_KEY 后重新构建。')
  }
  return supabase
}

export function createTransientSupabase(): SupabaseClient {
  if (!supabaseConfigured) throw new Error('在线登录尚未配置。')
  return createClient(supabaseUrl, supabasePublishableKey, {
    auth: {
      persistSession: false,
      autoRefreshToken: false,
      detectSessionInUrl: false
    }
  })
}
