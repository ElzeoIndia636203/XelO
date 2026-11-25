import { createClient } from '@supabase/supabase-js';

const url = import.meta.env.VITE_SUPABASE_URL || 'http://127.0.0.1:54321';
const anonKey = import.meta.env.VITE_SUPABASE_ANON_KEY || 'public-anon-placeholder';

export const supabase = createClient(url, anonKey);

export function must<T>(res: { data: T | null; error: { message: string } | null }): T {
  if (res.error) {
    throw new Error(res.error.message);
  }
  if (res.data === null) {
    throw new Error('empty_response');
  }
  return res.data;
}

export async function rpc<T>(name: string, args: Record<string, unknown> = {}): Promise<T> {
  const { data, error } = await supabase.rpc(name, args);
  if (error) {
    throw new Error(error.message);
  }
  return data as T;
}

export async function fn<T>(name: string, body?: Record<string, unknown>): Promise<T> {
  const { data, error } = await supabase.functions.invoke<T>(name, {
    body: body ?? {},
  });
  if (error) {
    let extractedCode: string | null = null;
    const ctx = (
      error as { context?: Response }
    ).context;
    if (ctx && typeof ctx.json === 'function') {
      try {
        const resObj = typeof ctx.clone === 'function' ? ctx.clone() : ctx;
        const payload = (await resObj.json()) as { error?: string; code?: string };
        if (typeof payload?.error === 'string' && payload.error.trim()) {
          extractedCode = payload.error.trim();
        } else if (typeof payload?.code === 'string' && payload.code.trim()) {
          extractedCode = payload.code.trim();
        }
      } catch {
        // Fallback to error.message below
      }
    }
    throw new Error(extractedCode ?? error.message);
  }
  return data as T;
}

export async function fetchAll<T>(
  fetchPage: (
    from: number,
    to: number,
  ) => PromiseLike<{ data: T[] | null; error: { message: string } | null }>,
  pageSize = 1000,
): Promise<T[]> {
  const all: T[] = [];
  let from = 0;
  while (true) {
    const to = from + pageSize - 1;
    const { data, error } = await fetchPage(from, to);
    if (error) throw new Error(error.message);
    const rows = data ?? [];
    all.push(...rows);
    if (rows.length < pageSize) break;
    from += pageSize;
  }
  return all;
}
