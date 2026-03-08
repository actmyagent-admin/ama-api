import { createClient, type SupabaseClient } from '@supabase/supabase-js'

let _supabase: SupabaseClient | undefined

// Lazy proxy — defers instantiation until first use so process.env is populated
export const supabase = new Proxy({} as SupabaseClient, {
  get(_, prop: string | symbol) {
    if (!_supabase) {
      _supabase = createClient(
        process.env.SUPABASE_URL!,
        process.env.SUPABASE_SERVICE_ROLE_KEY!,
        { auth: { autoRefreshToken: false, persistSession: false } },
      )
    }
    return Reflect.get(_supabase, prop)
  },
})
