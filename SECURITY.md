# Security & Privacy

## Threat Model & Rule-04 Controls Review

| Control | Status | Evidence |
|---|---|---|
| **Access Control (A01)** | Pass | RLS enabled on every table (`0002`–`0020`); `SECURITY DEFINER` helpers (`me()`, `my_role()`, `my_institution()`, `can_read_course()`) with `search_path = public`; students blocked from hidden tests, bank answers, class answer keys, reference solutions, and peer rows; `authorize_run` restricted to `service_role`. |
| **Authentication (A07)** | Pass | No password fields; OAuth + OTP (`shouldCreateUser: false`); `VITE_ALLOWED_DOMAINS` + DB `auth.users` sign-up gate trigger; 12 h student max session, 8 h staff idle timeout (`src/lib/session.tsx`). |
| **Injection & XSS (A05)** | Pass | Parameterized Supabase queries only; zero `dangerouslySetInnerHTML` on user/AI data; Judge0 receives base64-encoded code; no shell command interpolation. |
| **Supply Chain (A03)** | Pass | Exact pinned versions in `package.json` + `package-lock.json`; `npm audit --audit-level=moderate` = 0 vulnerabilities; Edge imports pinned (`npm:zod@3.24.2`, `npm:@supabase/supabase-js@2.119.2`); fonts and MediaPipe wasm self-hosted. |
| **Headers & CSP** | Pass (local) / Pending staging grade | `public/_headers` sets HSTS, `X-Content-Type-Options: nosniff`, `Referrer-Policy`, `Cross-Origin-Opener-Policy`, `X-Frame-Options: DENY`, and per-path CSP (`/` strict vs `/app/*` with `'wasm-unsafe-eval'`, Supabase `connect-src`, camera/mic/display-capture). Run `securityheaders.com` and Mozilla Observatory against staging URL on deploy. |
| **Edge Functions** | Pass | Allowlisted `ALLOWED_ORIGINS` CORS, POST-only (except `calendar` GET), 200 KB cap, Zod validation, user-scoped JWT client for user actions, `run-code` rate limiting, hidden test inputs/outputs never returned. |
| **Errors & Audit (A09, A10)** | Pass | UI displays mapped messages from `src/lib/errors.ts`; append-only `audit_log` records sign-up, approvals/returns, mark inputs, exam events, admin actions, plan changes, and bulk staff reads (`course_stats`, `at_risk_students`, `dept_stats`). |
| **Exam Integrity** | Pass | Server-side `exam_papers.deadline`, attendance-gated `start_exam`, remaining-time deadline for late arrivals, `end_assessment` autosubmit, 3-warning flag (`flagged = true`, never auto-terminates), flag review gate before `add_assessment_to_file`. |
| **Release Gate** | Pass | `scripts/postbuild-check.mjs` fails build on secret patterns, source maps, >25 MiB files, inline `<script>`, missing `_headers`/`CSP`, or missing `robots.txt`/`sitemap.xml`. |

## Privacy & Data Retention (DPDP Act 2023)
- Hosted in an India region (Supabase `ap-south-1`, Mumbai).
- Minimum PII collected (`full_name`, institutional `email`, `roll_no`, academic records).
- No continuous video recording during proctored exams; only proctor event metadata and event snapshots stored in the private `proctor` bucket, retained for **90 days** maximum before scheduled deletion.

## Incident Contact & CERT-In Reminder
- **Security / Incident Contact:** `security@elzeo.in` (Elzeo Future Technologies Pvt Ltd).
- **CERT-In Compliance:** Report any cyber security incident within **6 hours** of noticing or being brought to notice, in accordance with CERT-In directions (28 April 2022).
