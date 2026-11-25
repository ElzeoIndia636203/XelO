import { z } from 'npm:zod@3.24.2';
import { adminClient, userClient } from '../_shared/clients.ts';
import { json, readPostJson } from '../_shared/http.ts';
import {
  isStaffInviterRole,
  normalizeEmail,
  validateInviteBatch,
} from '../_shared/invites.ts';

const InviteItemSchema = z.object({
  email: z.string().email().max(254),
  fullName: z.string().min(1).max(160),
  role: z.enum(['super_admin', 'vc', 'coe', 'dean', 'hod', 'faculty', 'student']),
  classCode: z.string().min(1).max(32).optional(),
});

const RequestSchema = z.object({
  institutionId: z.string().uuid().nullable(),
  invites: z.array(InviteItemSchema).min(1).max(100),
});

const RATE_WINDOW_MS = 60_000;
const RATE_MAX_RECIPIENTS = 60;

Deno.serve(async (req: Request) => {
  const origin = req.headers.get('origin');
  const parsedBody = await readPostJson<unknown>(req);
  if (!parsedBody.ok) {
    return parsedBody.res;
  }

  const authHeader = req.headers.get('authorization');
  if (!authHeader) {
    return json({ error: 'forbidden' }, 401, origin);
  }

  const parsed = RequestSchema.safeParse(parsedBody.data);
  if (!parsed.success) {
    return json({ error: 'invalid_input' }, 400, origin);
  }

  const uClient = userClient(authHeader);
  const { data: authData, error: authErr } = await uClient.auth.getUser();
  if (authErr || !authData.user) {
    return json({ error: 'forbidden' }, 401, origin);
  }

  const admin = adminClient();
  const { data: actor, error: profErr } = await admin
    .from('profiles')
    .select('id, role, institution_id, active')
    .eq('id', authData.user.id)
    .single();

  if (profErr || !actor || !actor.active || !isStaffInviterRole(actor.role)) {
    return json({ error: 'forbidden' }, 403, origin);
  }

  const targetInstId =
    actor.role === 'super_admin' ? parsed.data.institutionId : actor.institution_id;

  let institutionDomain: string | null = null;
  if (targetInstId) {
    const { data: inst } = await admin
      .from('institutions')
      .select('email_domain')
      .eq('id', targetInstId)
      .single();
    institutionDomain = inst?.email_domain ?? null;
  }

  const validation = validateInviteBatch(
    parsed.data.invites,
    institutionDomain,
    actor.role,
  );
  if (!validation.ok) {
    return json(
      { error: validation.code, email: validation.email },
      validation.code === 'forbidden' ? 403 : 400,
      origin,
    );
  }

  const sinceIso = new Date(Date.now() - RATE_WINDOW_MS).toISOString();
  const { count: recentCount } = await admin
    .from('audit_log')
    .select('id', { count: 'exact', head: true })
    .eq('actor_id', actor.id)
    .eq('action', 'send_invite_email')
    .gte('at', sinceIso);

  if ((recentCount ?? 0) + parsed.data.invites.length > RATE_MAX_RECIPIENTS) {
    return json({ error: 'rate_limited' }, 429, origin);
  }

  const siteUrl = Deno.env.get('SITE_URL') ?? 'http://127.0.0.1:5173';
  const redirectTo = `${siteUrl.replace(/\/+$/, '')}/app/login`;

  const results: Array<{ email: string; status: 'sent' | 'skipped'; reason?: string }> = [];

  for (const item of parsed.data.invites) {
    const email = normalizeEmail(item.email);
    const { error: invErr } = await admin.auth.admin.inviteUserByEmail(email, {
      redirectTo,
      data: item.classCode ? { class_code: item.classCode } : undefined,
    });

    if (invErr) {
      results.push({ email, status: 'skipped', reason: invErr.message });
    } else {
      results.push({ email, status: 'sent' });
      await admin.rpc('audit', {
        p_action: 'send_invite_email',
        p_object_type: 'invite',
        p_object_id: email,
        p_detail: {
          role: item.role,
          class_code: item.classCode ?? null,
        },
        p_institution_id: targetInstId,
        p_actor_id: actor.id,
      });
    }
  }

  return json({ results }, 200, origin);
});
