-- =============================================================
-- 0018 End-sem practical schema
-- assessments, assessment_questions, exam_papers, proctor_events,
-- dept_question_titles view, and private proctor storage bucket
-- =============================================================

CREATE TYPE assessment_stage AS ENUM (
  'rules',
  'generate',
  'hod_pending',
  'scheduled',
  'live',
  'marks'
);

CREATE TYPE proctor_event_type AS ENUM (
  'tab_switch',
  'fullscreen_exit',
  'no_face',
  'multi_face',
  'copy_paste',
  'devtools',
  'disconnect',
  'camera_off'
);

CREATE TABLE assessments (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  institution_id uuid NOT NULL REFERENCES institutions(id) ON DELETE CASCADE,
  course_id uuid NOT NULL REFERENCES courses(id) ON DELETE CASCADE,
  batch_id uuid NOT NULL REFERENCES batches(id) ON DELETE CASCADE,
  rules jsonb NOT NULL DEFAULT '{
    "questions_per_student": 2,
    "mix": {"easy": 15, "medium": 15, "hard": 10},
    "visible_count": 2,
    "hidden_count": 3,
    "marks_per_test": 5,
    "viva_marks": 10,
    "duration_min": 120
  }'::jsonb,
  cos uuid[] NOT NULL DEFAULT ARRAY[]::uuid[],
  rules_locked boolean NOT NULL DEFAULT false,
  stage assessment_stage NOT NULL DEFAULT 'rules',
  hod_status plan_approval_status NOT NULL DEFAULT 'draft',
  hod_remark text,
  scheduled_at timestamptz,
  room text NOT NULL DEFAULT '',
  attendance_done boolean NOT NULL DEFAULT false,
  activated_at timestamptz,
  ended_at timestamptz,
  added_to_file boolean NOT NULL DEFAULT false,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (course_id, batch_id)
);

CREATE TABLE assessment_questions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  institution_id uuid NOT NULL REFERENCES institutions(id) ON DELETE CASCADE,
  assessment_id uuid NOT NULL REFERENCES assessments(id) ON DELETE CASCADE,
  question_id uuid NOT NULL REFERENCES questions(id) ON DELETE CASCADE,
  approved boolean NOT NULL DEFAULT false,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (assessment_id, question_id)
);

CREATE TABLE exam_papers (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  institution_id uuid NOT NULL REFERENCES institutions(id) ON DELETE CASCADE,
  assessment_id uuid NOT NULL REFERENCES assessments(id) ON DELETE CASCADE,
  student_id uuid NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
  q_ids uuid[] NOT NULL DEFAULT ARRAY[]::uuid[],
  started_at timestamptz NOT NULL DEFAULT now(),
  deadline timestamptz NOT NULL,
  extra_minutes integer NOT NULL DEFAULT 0 CHECK (extra_minutes >= 0),
  submitted_at timestamptz,
  flagged boolean NOT NULL DEFAULT false,
  paused_at timestamptz,
  pause_seconds_used integer NOT NULL DEFAULT 0 CHECK (pause_seconds_used >= 0),
  UNIQUE (assessment_id, student_id)
);

CREATE TABLE proctor_events (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  institution_id uuid NOT NULL REFERENCES institutions(id) ON DELETE CASCADE,
  paper_id uuid NOT NULL REFERENCES exam_papers(id) ON DELETE CASCADE,
  event_type proctor_event_type NOT NULL,
  severity integer NOT NULL DEFAULT 1 CHECK (severity BETWEEN 1 AND 3),
  detail text NOT NULL DEFAULT '',
  snapshot_path text,
  at timestamptz NOT NULL DEFAULT now(),
  reviewed_by uuid REFERENCES profiles(id) ON DELETE SET NULL,
  reviewed_at timestamptz
);

-- Department question bank view for no-repeat title checks across batches/semesters
CREATE OR REPLACE VIEW dept_question_titles AS
SELECT
  c.department_id,
  c.institution_id,
  q.id AS question_id,
  q.course_id,
  q.assessment_id,
  lower(trim(q.title)) AS normalized_title,
  q.title
FROM questions q
JOIN courses c ON c.id = q.course_id
WHERE q.kind = 'endsem';

CREATE INDEX idx_assessments_course ON assessments(course_id);
CREATE INDEX idx_assessment_questions_assessment ON assessment_questions(assessment_id);
CREATE INDEX idx_exam_papers_assessment ON exam_papers(assessment_id);
CREATE INDEX idx_exam_papers_student ON exam_papers(student_id);
CREATE INDEX idx_proctor_events_paper ON proctor_events(paper_id, at DESC);

DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.tables
    WHERE table_schema = 'storage' AND table_name = 'buckets'
  ) THEN
    INSERT INTO storage.buckets (id, name, public, file_size_limit)
    VALUES ('proctor', 'proctor', false, 5242880)
    ON CONFLICT (id) DO UPDATE SET public = false, file_size_limit = 5242880;
  END IF;
END $$;
