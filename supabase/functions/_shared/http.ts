const MAX_BODY_BYTES = 200 * 1024;

export function corsHeaders(origin: string | null): Record<string, string> {
  const allowed = (Deno.env.get('ALLOWED_ORIGINS') ?? '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
  const allowOrigin = origin && allowed.includes(origin) ? origin : allowed[0] ?? '';

  return {
    'Access-Control-Allow-Origin': allowOrigin,
    'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
    Vary: 'Origin',
  };
}

export function json(body: unknown, status = 200, origin: string | null = null): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      'Content-Type': 'application/json',
      ...corsHeaders(origin),
    },
  });
}

export async function readPostJson<T>(req: Request): Promise<{ ok: true; data: T } | { ok: false; res: Response }> {
  const origin = req.headers.get('origin');
  if (req.method === 'OPTIONS') {
    return { ok: false, res: new Response(null, { status: 204, headers: corsHeaders(origin) }) };
  }
  if (req.method !== 'POST') {
    return { ok: false, res: json({ error: 'method_not_allowed' }, 405, origin) };
  }
  const raw = await req.text();
  if (new TextEncoder().encode(raw).length > MAX_BODY_BYTES) {
    return { ok: false, res: json({ error: 'payload_too_large' }, 413, origin) };
  }
  try {
    return { ok: true, data: JSON.parse(raw) as T };
  } catch {
    return { ok: false, res: json({ error: 'invalid_json' }, 400, origin) };
  }
}
