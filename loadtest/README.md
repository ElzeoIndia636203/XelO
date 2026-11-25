# XeIO Load Tests (PRD §12 NFRs)

Requires [k6](https://k6.io/) and a staging Supabase + Judge0 deployment.

## Scenarios
1. **500 sign-ins in 5 minutes** (`p95 < 2 s`, error rate `< 1%`)
2. **500 submits in 60 s** (`p95 < 10 s`, error rate `< 1%`)
3. **500 concurrent students polling a live lab** (error rate `< 1%`)

## Run

```bash
k6 run \
  -e SUPABASE_URL=https://<project>.supabase.co \
  -e SUPABASE_ANON_KEY=<anon-key> \
  -e TEST_JWT=<student-jwt> \
  -e QUESTION_ID=<lab-question-uuid> \
  loadtest/xeio-load.js
```
