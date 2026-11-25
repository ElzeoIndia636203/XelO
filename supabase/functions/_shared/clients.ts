import { createClient, type SupabaseClient } from 'npm:@supabase/supabase-js@2.49.4';

function env(name: string): string {
  const v = Deno.env.get(name);
  if (!v) throw new Error(`missing_env_${name}`);
  return v;
}

export function adminClient(): SupabaseClient {
  return createClient(env('SUPABASE_URL'), env('SUPABASE_SERVICE_ROLE_KEY'), {
    auth: { persistSession: false },
  });
}

export function userClient(authHeader: string): SupabaseClient {
  return createClient(env('SUPABASE_URL'), env('SUPABASE_ANON_KEY'), {
    global: { headers: { Authorization: authHeader } },
    auth: { persistSession: false },
  });
}
