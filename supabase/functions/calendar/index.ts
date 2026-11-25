import { z } from 'npm:zod@3.24.2';
import { adminClient } from '../_shared/clients.ts';
import { buildIcs, type IcsEvent } from '../_shared/ics.ts';

const TokenSchema = z.string().uuid();

Deno.serve(async (req: Request) => {
  if (req.method !== 'GET') {
    return new Response('Method not allowed', { status: 405 });
  }

  const url = new URL(req.url);
  const token = url.searchParams.get('t') ?? '';
  const parsed = TokenSchema.safeParse(token);
  if (!parsed.success) {
    return new Response('Invalid calendar token', { status: 400 });
  }

  const admin = adminClient();
  const { data, error } = await admin.rpc('calendar_events', {
    p_token: parsed.data,
  });

  if (error) {
    const msg = error.message || '';
    if (msg.includes('invalid_token') || msg.includes('forbidden')) {
      return new Response('Calendar link invalid or revoked', { status: 401 });
    }
    return new Response('Could not load calendar feed', { status: 500 });
  }

  const rows = ((data as Array<{
    uid: string;
    summary: string;
    description: string;
    day: string;
    location: string;
  }> | null) ?? []).map<IcsEvent>((r) => ({
    uid: r.uid,
    summary: r.summary,
    description: r.description,
    day: r.day,
    location: r.location,
  }));

  const body = buildIcs('XeIO Lab Schedule', rows);
  return new Response(body, {
    status: 200,
    headers: {
      'Content-Type': 'text/calendar; charset=utf-8',
      'Cache-Control': 'no-store, private',
    },
  });
});
