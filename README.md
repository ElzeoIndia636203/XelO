# XeIO

**XeIO** is an AI faculty assistant LMS by **Elzeo Future Technologies Pvt Ltd, India** that plans, runs, and reports programming labs from course setup to the 14-section NBA/NAAC course file.

## Stack
- **Frontend:** Vite + React 19 + TypeScript (strict), React Router v7 (`/` static landing + `/app/*` SPA)
- **Editor & Vision:** CodeMirror 6 (C, C++, Java, Python, Rust, Go), MediaPipe Tasks Vision FaceDetector, `pdfjs-dist`, `qrcode-generator`
- **Backend:** Supabase (Postgres + RLS, `SECURITY DEFINER` workflow functions, Auth, Storage, Realtime, Deno Edge Functions)
- **Code Execution & AI:** Judge0 + LLM JSON output via Edge Functions
- **Hosting:** Cloudflare Pages (`public/_headers`, `public/_redirects`)

## Repository Map
- `src/` — Landing page, `/app` SPA, role portals (`admin`, `faculty`, `hod`, `oversight`, `student`), pure logic (`src/lib/logic/`), proctor runtime
- `supabase/migrations/` — Ordered schema, RLS, column guards, and workflow functions (`0001`–`0020`)
- `supabase/functions/` — Deno Edge Functions (`run-code`, `validate-question`, `ai-generate`, `send-invites`, `calendar`)
- `tests/` — Vitest unit tests (`tests/unit/`), PGlite DB/RLS tests (`tests/db/`), Playwright E2E (`tests/e2e/`)
- `loadtest/` — k6 load test scripts
- `scripts/` — `copy-vendor.mjs`, `postbuild-check.mjs`, screen captures (`scripts/screens/`)
- `docs/` — PRD, UI canvas references, screen checklist, architecture decisions, build progress

## Local Development
```bash
npm ci
supabase start
npm run dev
```

## Verification & Checks
```bash
npm run typecheck
npm run lint
npm test                # Vitest unit tests
npm run test:db         # PGlite DB + RLS tests
npm run build           # Build + postbuild release gate
npm run test:e2e        # Playwright E2E tests
npm run audit           # npm audit --audit-level=moderate
npm run check           # Runs all of the above
```
