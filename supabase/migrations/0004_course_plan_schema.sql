-- Phase 2: Courses, outcomes, CO-PO map, batches, enrollments, sessions, and holidays

CREATE TYPE plan_approval_status AS ENUM ('draft', 'sent', 'approved', 'declined');
CREATE TYPE session_status AS ENUM ('none', 'draft', 'active', 'conducted');
CREATE TYPE final_marks_status AS ENUM ('none', 'draft', 'sent', 'hod_approved', 'coe_accepted', 'returned');

CREATE TABLE courses (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  institution_id uuid NOT NULL REFERENCES institutions(id) ON DELETE CASCADE,
  department_id uuid NOT NULL REFERENCES departments(id) ON DELETE RESTRICT,
  faculty_id uuid NOT NULL REFERENCES profiles(id) ON DELETE RESTRICT,
  code text NOT NULL,
  title text NOT NULL,
  ltpc text NOT NULL DEFAULT '0-0-2-1',
  programme text NOT NULL DEFAULT 'B.Tech',
  semester text NOT NULL DEFAULT 'IV',
  section text NOT NULL DEFAULT 'A',
  academic_year text NOT NULL DEFAULT '2026-27',
  plan_status plan_approval_status NOT NULL DEFAULT 'draft',
  plan_remark text,
  rubric jsonb NOT NULL DEFAULT '{"att":10,"pre":5,"post":5,"vis":10,"hid":10,"viva":10}'::jsonb,
  allowed_langs text[] NOT NULL DEFAULT ARRAY['c', 'cpp', 'java', 'python', 'rust', 'go'],
  attainment_target integer NOT NULL DEFAULT 60 CHECK (attainment_target BETWEEN 1 AND 100),
  final_status final_marks_status NOT NULL DEFAULT 'none',
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE course_outcomes (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  course_id uuid NOT NULL REFERENCES courses(id) ON DELETE CASCADE,
  institution_id uuid NOT NULL REFERENCES institutions(id) ON DELETE CASCADE,
  code text NOT NULL,
  statement text NOT NULL,
  btl integer NOT NULL CHECK (btl BETWEEN 1 AND 6),
  unit integer NOT NULL DEFAULT 1 CHECK (unit BETWEEN 1 AND 10),
  UNIQUE (course_id, code)
);

CREATE TABLE co_po_map (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  course_id uuid NOT NULL REFERENCES courses(id) ON DELETE CASCADE,
  institution_id uuid NOT NULL REFERENCES institutions(id) ON DELETE CASCADE,
  co_id uuid NOT NULL REFERENCES course_outcomes(id) ON DELETE CASCADE,
  po_code text NOT NULL,
  level integer NOT NULL CHECK (level BETWEEN 0 AND 3),
  UNIQUE (co_id, po_code)
);

CREATE TABLE batches (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  course_id uuid NOT NULL REFERENCES courses(id) ON DELETE CASCADE,
  institution_id uuid NOT NULL REFERENCES institutions(id) ON DELETE CASCADE,
  name text NOT NULL,
  class_code text NOT NULL UNIQUE,
  slot text NOT NULL DEFAULT '',
  room text NOT NULL DEFAULT '',
  staff text NOT NULL DEFAULT '',
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (course_id, name)
);

CREATE TABLE enrollments (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  course_id uuid NOT NULL REFERENCES courses(id) ON DELETE CASCADE,
  batch_id uuid NOT NULL REFERENCES batches(id) ON DELETE CASCADE,
  institution_id uuid NOT NULL REFERENCES institutions(id) ON DELETE CASCADE,
  student_id uuid NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (course_id, student_id)
);

CREATE TABLE pending_enrollments (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  course_id uuid NOT NULL REFERENCES courses(id) ON DELETE CASCADE,
  batch_id uuid NOT NULL REFERENCES batches(id) ON DELETE CASCADE,
  institution_id uuid NOT NULL REFERENCES institutions(id) ON DELETE CASCADE,
  email text NOT NULL,
  roll_no text NOT NULL,
  full_name text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (course_id, email)
);

CREATE TABLE sessions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  course_id uuid NOT NULL REFERENCES courses(id) ON DELETE CASCADE,
  institution_id uuid NOT NULL REFERENCES institutions(id) ON DELETE CASCADE,
  n integer NOT NULL CHECK (n >= 1),
  topic text NOT NULL,
  co_id uuid REFERENCES course_outcomes(id) ON DELETE SET NULL,
  btl integer NOT NULL DEFAULT 3 CHECK (btl BETWEEN 1 AND 6),
  scheduled_date date,
  status session_status NOT NULL DEFAULT 'none',
  pre_open timestamptz,
  pre_close timestamptz,
  post_close timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (course_id, n)
);

CREATE TABLE holidays (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  institution_id uuid NOT NULL REFERENCES institutions(id) ON DELETE CASCADE,
  day date NOT NULL,
  label text NOT NULL,
  UNIQUE (institution_id, day)
);

CREATE INDEX idx_courses_inst ON courses(institution_id);
CREATE INDEX idx_courses_faculty ON courses(faculty_id);
CREATE INDEX idx_courses_dept ON courses(department_id);
CREATE INDEX idx_enrollments_student ON enrollments(student_id);
CREATE INDEX idx_pending_enrollments_email ON pending_enrollments(lower(email));
CREATE INDEX idx_sessions_course_n ON sessions(course_id, n);
