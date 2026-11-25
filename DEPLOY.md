# Deployment Guide — XeIO v1.0.0

Production deployment runbook for **Supabase** + **Cloudflare Pages**.

## 1. Supabase Project
1. Create a Supabase project in an **India region** (`ap-south-1`, Mumbai) on the **Pro** plan.
2. Enable the **Supavisor** connection pooler (transaction mode).

## 2. Database Migrations
Apply migrations `0001` through `0020` in order:
```bash
supabase link --project-ref <project-ref>
supabase db push
```

## 3. Authentication Providers & URLs
1. Enable **Google** and **Azure** OAuth providers in Supabase Auth.
2. Configure **Site URL** (`https://<your-domain>/app`) and **Redirect URLs** (`https://<your-domain>/app/**`).
3. Ensure email OTP / magic link templates are configured and sign-ups remain gated (`shouldCreateUser: false` on client + `auth.users` trigger on DB).

## 4. Storage Buckets
Verify private buckets created by migrations `0013` and `0018`:
- `class-files` (private, 20 MiB limit)
- `proctor` (private, 5 MiB limit, configure 90-day lifecycle cleanup)

## 5. Realtime
Enable Postgres Realtime replication on:
- `notifications`
- `submissions`

## 6. Edge Functions
Deploy Edge functions:
```bash
supabase functions deploy run-code
supabase functions deploy validate-question
supabase functions deploy ai-generate
supabase functions deploy send-invites
supabase functions deploy calendar --no-verify-jwt
```

## 7. Supabase Function Secrets
Set secrets in Supabase (`supabase secrets set ...`):
- `ALLOWED_ORIGINS=https://<your-domain>`
- `SITE_URL=https://<your-domain>`
- `JUDGE0_URL`
- `JUDGE0_API_KEY`
- `JUDGE0_AUTH_HEADER` (e.g. `X-Auth-Token`)
- `ANTHROPIC_API_KEY` (or chosen LLM provider key)
- `AI_MODEL`

## 8. Judge0
- Use Judge0 Cloud or self-hosted Judge0 CE/Extra.
- If self-hosting on Linux, ensure **`cgroup v1`** is enabled for Isolate sandboxed execution.

## 9. Cloudflare Pages
1. Connect the repository to **Cloudflare Pages**.
2. **Build command:** `npm run build`
3. **Build output directory:** `dist`
4. Set environment variables:
   - `VITE_SITE_URL=https://<your-domain>`
   - `VITE_SUPABASE_URL=https://<project-ref>.supabase.co`
   - `VITE_SUPABASE_ANON_KEY=<anon-key>`
   - `VITE_ALLOWED_DOMAINS=sanjivani.edu.in`
5. Verify `public/_headers` and `public/_redirects` are active in `dist/` and check header grades on `securityheaders.com` and Mozilla Observatory.

## 10. Custom Domain
Bind your custom domain in Cloudflare Pages with Full (strict) TLS and HSTS enabled.

## 11. First Super Admin Seed
Insert the initial Elzeo super admin invite in SQL Editor before first sign-in:
```sql
INSERT INTO invites (email, institution_id, role, full_name)
VALUES ('admin@elzeo.in', NULL, 'super_admin', 'Elzeo Admin');
```

## 12. Pre-Exam Checklist
1. Place `blaze_face_short_range.tflite` in `vendor-assets/` and run `node scripts/copy-vendor.mjs` before building so `/models/blaze_face_short_range.tflite` is self-hosted.
2. Perform a live end-to-end **real-webcam face detection check** on `/app/student/endsem` (S8).
3. Configure **Safe Exam Browser (SEB)** profile pointing to `https://<your-domain>/app/student/endsem` for lab machines.
