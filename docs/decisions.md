# Decisions for the build

These override or settle the PRD where noted. Add a dated line here for every new decision you make during the build.

## Stack and hosting (overrides PRD §12)

| PRD reference | Build decision | Why |
|---|---|---|
| Firebase Hosting / CDN | **Cloudflare Pages** (static, `_headers`, `_redirects`) | Owner's hosting choice |
| Node API (NestJS/Fastify) on Cloud Run | **Supabase:** Postgres RLS + security-definer functions for workflows; Deno Edge Functions for code runs, AI, invites and the calendar | One backend; every rule enforced in the database; no always-on API servers to scale |
| Redis/BullMQ queue | Judge0's own queue, plus per-user rate limits in `run-code` | Enough for the pilot (500 concurrent); revisit if p95 exceeds 10 s in the load test |
| Monaco or CodeMirror | **CodeMirror 6** | Smaller bundle; meets every IDE requirement |
| Next.js or Vite | **Vite** multi-page (landing + `/app` SPA) | Static output for Cloudflare Pages |
| LLM API | Provider adapter in `supabase/functions/_shared/llm.ts`; default Anthropic Messages API (`ANTHROPIC_API_KEY`, `AI_MODEL`) | Swappable; JSON-only prompts validated by code |

The PRD's API groups map to database functions (`rpc`) and edge functions. The client never writes status or mark columns directly.

## PRD §13 open items, resolved for the build

| Open item | Build decision (change later through settings, not code) |
|---|---|
| Identity provider | Support Google Workspace and Microsoft Entra ID through Supabase OAuth, plus a one-time email link fallback (`shouldCreateUser: false`). One sign-in page for all roles. |
| Face match against profile photo | v1 checks face presence and count every 2 s in the browser (MediaPipe). Photo match is behind a feature flag and off until the university supplies photos and consent wording. |
| Attainment threshold and weights | 60% threshold; levels 60/70/80; internal 40 / end-sem 60. Stored per institution. |
| End-sem on lab machines or laptops | Both. The secure check requires a single monitor, fullscreen, camera and entire-screen share. A Safe Exam Browser configuration is documented for lab machines. |
| Proctor snapshot retention | 90 days, then deleted by a scheduled job. Consent text shown in the waiting room. |
| Course file format | The 14 sections in PRD §10, in that order. |
| Languages per course | All six by default; faculty can restrict them in Course setup. |
| Banks shared across faculty | No, banks are per course. The department question bank stores end-sem sets for the no-repeat check. |
| Number of lab sessions | Default 30 (15 lab periods × 2), as on the canvas. The faculty can change the count in Session plan before saving. |

## Flows the canvas adds beyond the PRD text (build them; they are in `docs/screens.md`)

- **Session plan:** first lab day, last teaching day, lab weekdays, extra holidays and "reserve the last day for makeup". Shows a preview before saving. When dates are short, Assist suggests which adjacent topics to merge. Saving writes one date per session.
- **Course setup:** "Draft from syllabus with Assist" (upload PDF/TXT or paste text) proposes COs with BTL and unit plus a CO–PO map, all editable before insert.
- **Lab questions:** "Assist pick best 2", a bulk pick for N sessions, "Draft candidates for N remaining sessions", "Write own question" and "Upload own" (JSON).
- **Banks:** bulk approve all ready banks, generate all missing banks, MCQ upload from CSV, and a pre/post overlap counter.
- **Sessions:**
  - Attendance is suggested from lab check-ins: opening the lab within 3 h counts as present.
  - Pre-test analytics: a 0–5 histogram, % correct per level and an insight line.
  - Live alerts: struggling = 4+ runs with nothing passing; idle = 15 min.
  - Alert actions: send hint, send a TA to seats (uses batch staff names), add to the slow-learner list.
  - Student inspector timeline.
- **Classroom:** weeks are derived from session dates, with "Jump to this week". Assist task drafts are previewed before "Add to this week". File resources go to private storage with signed URLs.
- **Reports:**
  - CSV downloads (mark list, actual log, internal mark sheet) and CO-selectable distributions with 40, target and 80 markers.
  - Manual slow and fast learner flags.
  - Student lab files tab with "Print all".
  - A course snapshot is stored for the oversight dashboards.
- **Notifications** (bell plus realtime) for:
  - plan, end-sem set and final-marks decisions
  - exam scheduled
  - hints during a lab
- **Personal calendar feed:** an ICS link per user that can be reset.
- **Preview as student:** the faculty opens the lab IDE in read-only preview.

## Pitfalls already learned (do not repeat)

1. `FORCE ROW LEVEL SECURITY` makes definer helpers recurse. Use plain RLS.
2. `INSERT … RETURNING` fails RLS unless the select policy also matches the new row (e.g. `courses_read` must include `faculty_id = auth.uid()`).
3. One generic plpgsql guard trigger that references other tables' columns breaks. Write one guard function per table.
4. The session provider must expose a `restored` flag and wait for `getSession()` before route guards redirect. Otherwise deep links are lost on refresh.
5. `useLoad` must ignore stale responses (a request sequence counter). Otherwise a slow first load overwrites newer data.
6. Render a child that starts a session run only after the runs list has loaded. Otherwise a run is created twice.
7. The MediaPipe face model needs NormalizationOptions metadata (mean/std 127.5). Ship a model file that has it, and test detection in e2e.
8. CSP on `/*` in Cloudflare `_headers` merges with per-path rules. Set CSP per path only.
9. Error codes from the database must stay exact. Do not append text to them, or the friendly message mapping breaks.
10. Approval visibility must be scoped to the same institution. A role-only policy leaks across institutions.
11. A dark header button style must not leak into dropdowns rendered inside the header. Scope it with child selectors.

## Build-time decisions log

- **2026-11-25 (Phase 1):** Added `profiles.plan_override` (nullable, falling back to `institutions.plan`) so Super Admin can adjust an individual faculty member's plan (`Move to Elite` / `Move to Pro` on `A4`) while preserving institution-level subscription periods (`institutions.plan`, `plan_start`, `plan_end`) on `A3`.
- **2026-11-25 (Phase 1):** Landing page (`index.html` + `src/landing/main.ts`) renders static semantic HTML importing only CSS (`landing.css`), keeping landing JS at 0 KB (well under the 100 KB budget).
- **2026-11-25 (Phase 2):** Added `pdfjs-dist` (`6.5.438`) for client-side PDF syllabus parsing on `F1a`, self-hosting the worker at `public/vendor/pdfjs/pdf.worker.min.mjs` via `scripts/copy-vendor.mjs` and lazy-loading it in `src/lib/pdf.ts` so strict `'self'` CSP holds with zero CDN fetches.
- **2026-11-25 (Phase 2):** Added `read-excel-file` (`9.3.20`) for lazy-loaded `.xlsx` roster imports on `F2` (0 npm audit vulnerabilities).
- **2026-11-25 (Phase 2):** Switched `is_api_user()` in `0002_access.sql` (plus course-plan edit guards `guard_course_outcomes` and `guard_co_po_map`) to `SECURITY INVOKER` so `BEFORE UPDATE` triggers see the true API role (`authenticated`/`anon`) instead of `postgres` and reliably auto-reopen declined plans via `reopen_declined_course`.
- **2026-11-25 (Phase 3):** `ai-generate` (`lab_candidates`) passes `course.allowed_langs` to the LLM and validates reference solutions for every enabled language (instead of C-only) so `validate-question` enforces PRD §5.4 across all enabled course languages without rejecting default 6-language courses.
- **2026-11-25 (Phase 3):** `0007_lab_prep_schema.sql` creates `submissions` with nullable `session_run_id` / `exam_paper_id` columns (keeping `session_runs` and `attendance` in Phase 4); `authorize_run` fails closed on student `lab` `submit` until Phase 4 creates `session_runs` and `attendance`.
- **2026-11-25 (Phase 3):** Updated `fn()` in `src/lib/supabase.ts` to extract `{ error }` codes from `FunctionsHttpError.context` responses so sequential bulk Edge calls preserve exact server codes (`daily_cap`, `total_cap`, `rate_limited`, `invalid_ai_shape`).
- **2026-11-25 (Phase 4):** Pinned CodeMirror 6 packages (`@codemirror/state@6.7.6`, `@codemirror/view@6.44.0`, `@codemirror/commands@6.11.2`, `@codemirror/language@6.13.1`, `@codemirror/lang-cpp@6.0.3`, `@codemirror/lang-java@6.0.2`, `@codemirror/lang-python@6.2.1`, `@codemirror/lang-rust@6.0.2`, `@codemirror/lang-go@6.0.1`, `@lezer/highlight@1.2.5`) inside a dynamic-imported chunk (`src/components/CodeEditor.tsx`), keeping landing JS at 0 KB and the main `/app` boot chunk small.
- **2026-11-25 (Phase 4):** Defined `sessionMarks` in `src/lib/logic/rubric.ts` to score each rubric criterion independently out of the 50-mark course rubric (`late` receives half of `rubric.att`), and `attendancePct` counts both `present` and `late` toward session attendance.
- **2026-11-25 (Phase 4):** Added `notifications` (`0010_lab_run_schema.sql`) with column-level guard `guard_notifications` (recipients can update only `read_at`) and service-only `notify()` / `send_hint` RPC for live faculty hints over Supabase Realtime (`S0` bell & `S4` IDE banner).

## Phase 5 decisions

- **QR generation (`qrcode-generator@2.0.4`):** Installed pinned `qrcode-generator@2.0.4` (approved in `02-stack.md`) and wrapped it in `src/lib/logic/qr.ts` to emit SVG path geometry cleanly in React without extra runtime dependencies or HTML injection.
- **Bulk lab file ZIP (`src/lib/logic/zip.ts`):** Implemented a zero-dependency PKZIP Store archive writer with IEEE 802.3 CRC-32 rather than adding a zip library, keeping the client bundle small.
- **Public verification (`/app/verify/:courseId/:studentId`):** Implemented via an `anon`-executable `SECURITY DEFINER` RPC `verify_lab_file` returning only official summary fields (institution, course, student name/roll, attendance %, internal /100, approval stage, verification ID) without opening PII tables to anonymous RLS reads.
- **Notifications scope in Phase 5:** Wired `notify()` triggers into `submit_course_plan`, `decide_course_plan`, `submit_final_marks`, and `decide_final_marks` alongside existing Phase 4 lab hint/slow notifications; end-sem schedule/result notifications will be added in Phase 7 when end-sem tables exist.
- **Personal ICS calendar feed (`supabase/functions/calendar`):** Deployed `--no-verify-jwt`, authorized solely via `profiles.calendar_token` query parameter calling `service_role` RPC `calendar_events(uuid)`, and revocable via `rotate_calendar_token`.

## Phase 6 (`xeio-06-oversight`) — 2026-11-25

- **Scoped stats RPCs (`0016_oversight_functions.sql`):** `course_stats`, `at_risk_students`, `live_lab_stats`, and `dept_stats` are `VOLATILE` `SECURITY DEFINER` functions (rather than `STABLE`) because they call `public.audit(...)` to log staff bulk reads in `audit_log`.
- **Direct institution update guard (`0017_oversight_access.sql`):** `institutions.min_attendance_pct` is protected both by table-level grants (`authenticated` has no `UPDATE` privilege) and a `BEFORE UPDATE` guard trigger (`guard_institutions_update`), ensuring updates go exclusively through `set_min_attendance(integer)` (restricted to `coe`/`vc`).
- **Oversight console layout:** `OversightConsole.tsx` uses a dark topbar navigation layout (instead of the side-rail `ConsoleShell`) to match `docs/ui/Oversight.dc.html`, with role-specific monitor `<h1>` headings (`VC monitor`, `CoE monitor`, `Dean monitor`).

## Phase 7 (`xeio-07-endsem`) — 2026-11-25

- **`authorize_run` signature (`0020_endsem_workflows.sql`):** Replaced the 5-argument `authorize_run(uuid, uuid, run_context, run_mode, uuid)` in-place (preserving `0009_lab_prep_workflows.sql` signature) to extend `p_context = 'exam'` cleanly without creating an overloaded function.
- **Browser proctoring (`src/lib/proctor-runtime.ts`):** Camera and entire-screen `MediaStream` objects are held at module level so they survive navigation from the waiting room (`S8`) to the proctored IDE (`S9`) without re-prompting.
- **Workbench exam support (`src/components/Workbench.tsx`):** Added optional `runContext` (`'lab' | 'exam'`) and `paperId` props so the proctored IDE reuses the shared CodeMirror 6 workbench.

## Deployment & Auth decisions — 2026-11-25

- **OTP sign-in for first-time invited users (`src/app/pages/LoginPage.tsx`):** Switched `signInWithOtp` from `shouldCreateUser: false` to `shouldCreateUser: true`. With `shouldCreateUser: false`, GoTrue rejects invited users who have a `public.invites` row but no `auth.users` row yet (`422 otp_disabled`) before the database sign-up gate runs. Invites and email domains remain strictly enforced server-side by `preflight_sign_in` and the `auth.users` `BEFORE INSERT` trigger (`0003_workflows.sql`).
