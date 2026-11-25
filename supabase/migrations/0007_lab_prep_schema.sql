-- Phase 3: Lab questions, test cases, reference solutions, banks, and submissions

CREATE TYPE question_kind AS ENUM ('lab', 'endsem', 'task');
CREATE TYPE question_difficulty AS ENUM ('easy', 'medium', 'hard');
CREATE TYPE question_status AS ENUM ('candidate', 'approved', 'rejected');
CREATE TYPE question_source AS ENUM ('ai', 'faculty');
CREATE TYPE bank_type AS ENUM ('pre', 'post');
CREATE TYPE run_context AS ENUM ('lab', 'exam');
CREATE TYPE run_mode AS ENUM ('run', 'submit');

CREATE TABLE questions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  institution_id uuid NOT NULL REFERENCES institutions(id) ON DELETE CASCADE,
  course_id uuid NOT NULL REFERENCES courses(id) ON DELETE CASCADE,
  kind question_kind NOT NULL DEFAULT 'lab',
  session_id uuid REFERENCES sessions(id) ON DELETE CASCADE,
  assessment_id uuid,
  co_code text NOT NULL DEFAULT 'CO1' CHECK (length(trim(co_code)) > 0),
  difficulty question_difficulty NOT NULL DEFAULT 'medium',
  title text NOT NULL CHECK (length(trim(title)) > 0),
  statement text NOT NULL CHECK (length(trim(statement)) > 0),
  input_spec text NOT NULL DEFAULT '',
  output_spec text NOT NULL DEFAULT '',
  constraints text NOT NULL DEFAULT '',
  starter_code jsonb NOT NULL DEFAULT '{}'::jsonb,
  status question_status NOT NULL DEFAULT 'candidate',
  source question_source NOT NULL DEFAULT 'ai',
  valid boolean,
  validation_note text,
  created_by uuid REFERENCES profiles(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE test_cases (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  institution_id uuid NOT NULL REFERENCES institutions(id) ON DELETE CASCADE,
  question_id uuid NOT NULL REFERENCES questions(id) ON DELETE CASCADE,
  ord integer NOT NULL CHECK (ord >= 1),
  input text NOT NULL DEFAULT '',
  expected text NOT NULL DEFAULT '',
  hidden boolean NOT NULL DEFAULT false,
  marks integer NOT NULL DEFAULT 5 CHECK (marks >= 0),
  UNIQUE (question_id, ord)
);

CREATE TABLE reference_solutions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  institution_id uuid NOT NULL REFERENCES institutions(id) ON DELETE CASCADE,
  question_id uuid NOT NULL REFERENCES questions(id) ON DELETE CASCADE,
  lang text NOT NULL CHECK (lang IN ('c', 'cpp', 'java', 'python', 'rust', 'go')),
  code text NOT NULL CHECK (char_length(code) <= 50000),
  UNIQUE (question_id, lang)
);

CREATE TABLE session_questions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  institution_id uuid NOT NULL REFERENCES institutions(id) ON DELETE CASCADE,
  session_id uuid NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
  slot integer NOT NULL CHECK (slot IN (1, 2)),
  question_id uuid NOT NULL REFERENCES questions(id) ON DELETE RESTRICT,
  UNIQUE (session_id, slot),
  UNIQUE (session_id, question_id)
);

CREATE TABLE bank_items (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  institution_id uuid NOT NULL REFERENCES institutions(id) ON DELETE CASCADE,
  session_id uuid NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
  bank bank_type NOT NULL,
  level question_difficulty NOT NULL,
  stem text NOT NULL CHECK (length(trim(stem)) > 0),
  options jsonb NOT NULL CHECK (
    jsonb_typeof(options) = 'array' AND jsonb_array_length(options) BETWEEN 2 AND 6
  ),
  answer integer NOT NULL CHECK (answer >= 0 AND answer < jsonb_array_length(options)),
  approved boolean NOT NULL DEFAULT false,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE submissions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  institution_id uuid NOT NULL REFERENCES institutions(id) ON DELETE CASCADE,
  course_id uuid NOT NULL REFERENCES courses(id) ON DELETE CASCADE,
  session_id uuid REFERENCES sessions(id) ON DELETE SET NULL,
  session_run_id uuid,
  exam_paper_id uuid,
  student_id uuid NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
  question_id uuid NOT NULL REFERENCES questions(id) ON DELETE CASCADE,
  context run_context NOT NULL DEFAULT 'lab',
  mode run_mode NOT NULL DEFAULT 'run',
  lang text NOT NULL CHECK (lang IN ('c', 'cpp', 'java', 'python', 'rust', 'go')),
  code text NOT NULL CHECK (char_length(code) <= 50000),
  visible_passed integer NOT NULL DEFAULT 0 CHECK (visible_passed >= 0),
  visible_total integer NOT NULL DEFAULT 0 CHECK (visible_total >= 0),
  hidden_passed integer NOT NULL DEFAULT 0 CHECK (hidden_passed >= 0),
  hidden_total integer NOT NULL DEFAULT 0 CHECK (hidden_total >= 0),
  marks integer NOT NULL DEFAULT 0 CHECK (marks >= 0),
  verdict text NOT NULL DEFAULT 'pending',
  runtime_ms integer NOT NULL DEFAULT 0 CHECK (runtime_ms >= 0),
  memory_kb integer NOT NULL DEFAULT 0 CHECK (memory_kb >= 0),
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX idx_questions_course_session ON questions(course_id, session_id);
CREATE INDEX idx_test_cases_question_ord ON test_cases(question_id, ord);
CREATE INDEX idx_session_questions_session ON session_questions(session_id, slot);
CREATE INDEX idx_bank_items_session_bank_level ON bank_items(session_id, bank, level);
CREATE INDEX idx_submissions_student_created ON submissions(student_id, created_at DESC);
CREATE INDEX idx_submissions_course_session ON submissions(course_id, session_id);
