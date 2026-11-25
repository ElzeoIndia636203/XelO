-- Phase 4: Lab runs, attendance, test attempts, drafts, viva, check-ins, flags, notifications, and Realtime

CREATE TYPE attendance_state AS ENUM ('present', 'late', 'absent');

CREATE TABLE session_runs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  institution_id uuid NOT NULL REFERENCES institutions(id) ON DELETE CASCADE,
  session_id uuid NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
  batch_id uuid NOT NULL REFERENCES batches(id) ON DELETE CASCADE,
  started_at timestamptz,
  ended_at timestamptz,
  attendance_done boolean NOT NULL DEFAULT false,
  post_close timestamptz,
  remark text NOT NULL DEFAULT '',
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (session_id, batch_id)
);

CREATE TABLE attendance (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  institution_id uuid NOT NULL REFERENCES institutions(id) ON DELETE CASCADE,
  session_run_id uuid REFERENCES session_runs(id) ON DELETE CASCADE,
  assessment_id uuid,
  student_id uuid NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
  state attendance_state NOT NULL,
  marked_by uuid REFERENCES profiles(id) ON DELETE SET NULL,
  at timestamptz NOT NULL DEFAULT now(),
  CHECK (session_run_id IS NOT NULL OR assessment_id IS NOT NULL)
);

CREATE UNIQUE INDEX idx_attendance_run_student
  ON attendance(session_run_id, student_id)
  WHERE session_run_id IS NOT NULL;

CREATE UNIQUE INDEX idx_attendance_assessment_student
  ON attendance(assessment_id, student_id)
  WHERE assessment_id IS NOT NULL;

CREATE TABLE test_attempts (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  institution_id uuid NOT NULL REFERENCES institutions(id) ON DELETE CASCADE,
  session_id uuid NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
  student_id uuid NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
  bank bank_type NOT NULL,
  item_ids uuid[] NOT NULL DEFAULT ARRAY[]::uuid[],
  answers jsonb NOT NULL DEFAULT '{}'::jsonb,
  score integer CHECK (score IS NULL OR (score >= 0 AND score <= 5)),
  started_at timestamptz NOT NULL DEFAULT now(),
  submitted_at timestamptz,
  UNIQUE (session_id, student_id, bank)
);

CREATE TABLE drafts (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  institution_id uuid NOT NULL REFERENCES institutions(id) ON DELETE CASCADE,
  student_id uuid NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
  question_id uuid NOT NULL REFERENCES questions(id) ON DELETE CASCADE,
  context run_context NOT NULL DEFAULT 'lab',
  lang text NOT NULL CHECK (lang IN ('c', 'cpp', 'java', 'python', 'rust', 'go')),
  code text NOT NULL DEFAULT '' CHECK (char_length(code) <= 50000),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (student_id, question_id, context, lang)
);

CREATE TABLE viva (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  institution_id uuid NOT NULL REFERENCES institutions(id) ON DELETE CASCADE,
  session_id uuid REFERENCES sessions(id) ON DELETE CASCADE,
  assessment_id uuid,
  student_id uuid NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
  marks numeric(5,2) NOT NULL CHECK (marks >= 0),
  examiner_id uuid NOT NULL REFERENCES profiles(id) ON DELETE RESTRICT,
  updated_at timestamptz NOT NULL DEFAULT now(),
  CHECK (session_id IS NOT NULL OR assessment_id IS NOT NULL)
);

CREATE UNIQUE INDEX idx_viva_session_student
  ON viva(session_id, student_id)
  WHERE session_id IS NOT NULL;

CREATE UNIQUE INDEX idx_viva_assessment_student
  ON viva(assessment_id, student_id)
  WHERE assessment_id IS NOT NULL;

CREATE TABLE lab_checkins (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  institution_id uuid NOT NULL REFERENCES institutions(id) ON DELETE CASCADE,
  session_id uuid NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
  student_id uuid NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
  first_at timestamptz NOT NULL DEFAULT now(),
  last_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (session_id, student_id)
);

CREATE TABLE course_flags (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  institution_id uuid NOT NULL REFERENCES institutions(id) ON DELETE CASCADE,
  course_id uuid NOT NULL REFERENCES courses(id) ON DELETE CASCADE,
  student_id uuid NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
  kind text NOT NULL CHECK (kind IN ('slow', 'fast')),
  note text NOT NULL DEFAULT '',
  created_by uuid REFERENCES profiles(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (course_id, student_id, kind)
);

CREATE TABLE notifications (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  institution_id uuid NOT NULL REFERENCES institutions(id) ON DELETE CASCADE,
  user_id uuid NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
  kind text NOT NULL CHECK (length(trim(kind)) > 0),
  title text NOT NULL CHECK (length(trim(title)) > 0),
  body text NOT NULL DEFAULT '',
  link text NOT NULL DEFAULT '',
  read_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE submissions
  ADD CONSTRAINT fk_submissions_session_run
  FOREIGN KEY (session_run_id)
  REFERENCES session_runs(id)
  ON DELETE SET NULL;

CREATE INDEX idx_session_runs_sess_batch ON session_runs(session_id, batch_id);
CREATE INDEX idx_attendance_student ON attendance(student_id);
CREATE INDEX idx_test_attempts_sess_student ON test_attempts(session_id, student_id);
CREATE INDEX idx_drafts_student_q ON drafts(student_id, question_id);
CREATE INDEX idx_lab_checkins_sess ON lab_checkins(session_id, student_id);
CREATE INDEX idx_notifications_user_created ON notifications(user_id, created_at DESC);

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_publication WHERE pubname = 'supabase_realtime') THEN
    ALTER PUBLICATION supabase_realtime ADD TABLE public.submissions, public.notifications;
  END IF;
END $$;
