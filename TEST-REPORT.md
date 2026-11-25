# XeIO Test Report

Date: 2026-11-25 (Phase 8 · `xeio-08-release` · `v1.0.0`)

## Quality Gates

| Gate | Command | Result | Scope / Notes |
|---|---|---|---|
| Typecheck | `npm run typecheck` | Pass (`0` errors) | Full TS strict compile |
| Lint | `npm run lint` | Pass (`0` problems) | eslint + react-hooks + security |
| Unit tests | `npm test` (`vitest run tests/unit`) | Pass (`20` files, `59` tests) | All `src/lib/logic/` modules + Edge shared helpers (`ics`, `ai-schema`, `judge`, `starters`) |
| DB + RLS | `npm run test:db` (`vitest run tests/db`) | Pass (`8` files, `31` tests) | Real migrations `0001`–`0020` on PGlite with `anon`/`authenticated`/`service_role` stand-in |
| Edge static | `deno check` / `deno lint` | Blocked | `deno` CLI not installed on Windows host (`DENO_NOT_INSTALLED`); Edge shared modules tested via Vitest |
| Build + Gate | `npm run build` | Pass (`142+` files checked) | `copy-vendor`, `tsc`, `vite build` (211 modules), `postbuild-check.mjs` |
| E2E | `npm run test:e2e` (`playwright test`) | Pass (`36` tests) | Mocked Supabase/Judge0/AI across Phases 0–7, all 7 roles, deep links, CSP, axe a11y |
| Screens | `npx playwright test -c scripts/screens/pw.config.ts` | Pass (`6` test blocks, `0` page errors) | Desktop `1440px` + Mobile `390px` across Phases 0–7 |
| Security audit | `npm run audit` (`npm audit --audit-level=moderate`) | Pass (`0` vulnerabilities) | 0 moderate+ vulnerabilities |

## What the DB & RLS Tests Prove
- **Sign-up gate & auth (`foundation.test.ts`):** Rejects uninvited emails and domain mismatches; assigns profile role from invite; enforces institution scoping and append-only `audit_log`; enforces Pro/Elite AI credit caps and refunds.
- **Course setup & planning (`course_plan.test.ts`):** Enforces rubric = 50, required COs, plan locking on send, immutable HOD approval with content hash, 126 → 63/63 batch split, and `save_session_plan` ownership/lock.
- **Lab prep (`lab_prep.test.ts`):** Enforces session activation only with 2 valid questions + approved 15/15/15 pre/post banks with no overlap; blocks students from hidden tests, reference solutions, bank items, unpicked questions, and peer submissions; restricts `authorize_run` to `service_role`.
- **Lab run (`lab_run.test.ts`):** Enforces check-ins, batch-only `save_attendance`, idempotent `start_session_run`, pre-test 2E/2M/1H single-attempt close on attendance, post-test unlock only when all hidden tests pass, viva caps, and peer isolation.
- **Classroom & reports (`classroom_reports.test.ts`):** Hides `class_answer_keys` from students, grades `submit_class_response` server-side, routes notifications, enforces HOD → CoE final marks pipeline with mandatory return remarks, scopes `calendar_events` to revocable tokens, and exposes minimal `verify_lab_file` to `anon`.
- **Oversight (`oversight.test.ts`):** Verifies `course_stats`, `at_risk_students`, `live_lab_stats`, `dept_stats` school scoping for Dean, HOD department isolation, `set_min_attendance` and holiday writes restricted to CoE/VC, and `institutions` column protection.
- **End-sem & proctoring (`endsem.test.ts`):** Enforces rules validation, exact 30 valid questions with >= 4/CO, lock while with HOD, no scheduling before approval, attendance-gated activation, present-only exam start with 2-question draw, `authorize_run` exam validation, extra time, 3-warning flag without termination, autosubmit on `end_assessment`, absent != zero, and flag review gate before `add_assessment_to_file`.

## Load Test (`loadtest/xeio-load.js`)
- **Script:** k6 script prepared for 500 sign-ins/5m (`p95 < 2s`), 500 submits/60s (`p95 < 10s`), and 500 concurrent live-lab pollers (`error rate < 1%`).
- **Execution status:** Not executed against live staging yet (requires deployed Supabase Pro + Judge0 staging target).
