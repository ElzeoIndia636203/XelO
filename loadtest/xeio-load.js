/* global __ENV */
import http from 'k6/http';
import { check, sleep } from 'k6';

const SUPABASE_URL = __ENV.SUPABASE_URL || 'https://staging.supabase.co';
const ANON_KEY = __ENV.SUPABASE_ANON_KEY || '';
const TEST_JWT = __ENV.TEST_JWT || '';
const QUESTION_ID = __ENV.QUESTION_ID || '';

export const options = {
  scenarios: {
    sign_ins_500_in_5m: {
      executor: 'constant-arrival-rate',
      rate: 100,
      timeUnit: '1m',
      duration: '5m',
      preAllocatedVUs: 50,
      maxVUs: 150,
      exec: 'signInFlow',
    },
    submits_500_in_60s: {
      executor: 'constant-arrival-rate',
      rate: 500,
      timeUnit: '1m',
      duration: '1m',
      preAllocatedVUs: 100,
      maxVUs: 250,
      exec: 'submitFlow',
      startTime: '5m10s',
    },
    live_lab_500_concurrent: {
      executor: 'constant-vus',
      vus: 500,
      duration: '2m',
      exec: 'pollLiveLab',
      startTime: '6m20s',
    },
  },
  thresholds: {
    'http_req_duration{scenario:sign_ins_500_in_5m}': ['p(95)<2000'],
    'http_req_duration{scenario:submits_500_in_60s}': ['p(95)<10000'],
    http_req_failed: ['rate<0.01'],
  },
};

const baseHeaders = {
  apikey: ANON_KEY,
  'Content-Type': 'application/json',
};

export function signInFlow() {
  const res = http.post(
    `${SUPABASE_URL}/rest/v1/rpc/preflight_sign_in`,
    JSON.stringify({ p_email: 'student1@sanjivani.edu.in' }),
    { headers: baseHeaders },
  );
  check(res, { 'preflight 200': (r) => r.status === 200 });
}

export function submitFlow() {
  const res = http.post(
    `${SUPABASE_URL}/functions/v1/run-code`,
    JSON.stringify({
      question_id: QUESTION_ID,
      lang: 'python',
      code: 'print(input())',
      mode: 'submit',
      context: 'lab',
    }),
    {
      headers: {
        ...baseHeaders,
        Authorization: `Bearer ${TEST_JWT}`,
      },
    },
  );
  check(res, { 'run-code 200': (r) => r.status === 200 });
}

export function pollLiveLab() {
  const res = http.get(
    `${SUPABASE_URL}/rest/v1/session_runs?select=id,started_at,ended_at&limit=5`,
    {
      headers: {
        ...baseHeaders,
        Authorization: `Bearer ${TEST_JWT}`,
      },
    },
  );
  check(res, { 'poll 200': (r) => r.status === 200 });
  sleep(5);
}
