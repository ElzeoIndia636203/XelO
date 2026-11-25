-- Phase 5: Classroom timeline items/keys/responses, course notes, snapshots, notifications link guard, private class-files storage

CREATE TYPE class_item_kind AS ENUM ('task', 'resource', 'announcement');
CREATE TYPE class_task_type AS ENUM ('quiz', 'fill', 'predict', 'debug', 'assignment', 'poll');

CREATE TABLE class_items (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  institution_id uuid NOT NULL REFERENCES institutions(id) ON DELETE CASCADE,
  course_id uuid NOT NULL REFERENCES courses(id) ON DELETE CASCADE,
  week integer NOT NULL CHECK (week BETWEEN 1 AND 30),
  kind class_item_kind NOT NULL,
  task_type class_task_type,
  title text NOT NULL CHECK (length(trim(title)) > 0),
  body text NOT NULL DEFAULT '',
  payload jsonb NOT NULL DEFAULT '{}'::jsonb,
  due_at timestamptz,
  url text CHECK (url IS NULL OR url ~* '^https://'),
  file_path text,
  created_by uuid REFERENCES profiles(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT class_items_task_type_chk CHECK (
    (kind = 'task' AND task_type IS NOT NULL) OR (kind <> 'task' AND task_type IS NULL)
  )
);

CREATE TABLE class_answer_keys (
  item_id uuid PRIMARY KEY REFERENCES class_items(id) ON DELETE CASCADE,
  institution_id uuid NOT NULL REFERENCES institutions(id) ON DELETE CASCADE,
  answer jsonb NOT NULL DEFAULT '{}'::jsonb
);

CREATE TABLE class_responses (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  institution_id uuid NOT NULL REFERENCES institutions(id) ON DELETE CASCADE,
  item_id uuid NOT NULL REFERENCES class_items(id) ON DELETE CASCADE,
  student_id uuid NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
  answer jsonb NOT NULL DEFAULT '{}'::jsonb,
  score numeric(5,2),
  submitted_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (item_id, student_id)
);

CREATE TABLE course_notes (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  institution_id uuid NOT NULL REFERENCES institutions(id) ON DELETE CASCADE,
  course_id uuid NOT NULL UNIQUE REFERENCES courses(id) ON DELETE CASCADE,
  bos_suggestions text NOT NULL DEFAULT '',
  internal_summary text NOT NULL DEFAULT '',
  overall_summary text NOT NULL DEFAULT '',
  updated_by uuid REFERENCES profiles(id) ON DELETE SET NULL,
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE course_snapshots (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  institution_id uuid NOT NULL REFERENCES institutions(id) ON DELETE CASCADE,
  course_id uuid NOT NULL UNIQUE REFERENCES courses(id) ON DELETE CASCADE,
  students integer NOT NULL DEFAULT 0 CHECK (students >= 0),
  internal_mean numeric(5,2) NOT NULL DEFAULT 0,
  below_40 integer NOT NULL DEFAULT 0 CHECK (below_40 >= 0),
  co_internal jsonb NOT NULL DEFAULT '{}'::jsonb,
  co_overall jsonb NOT NULL DEFAULT '{}'::jsonb,
  overall_pct numeric(5,2) NOT NULL DEFAULT 0,
  computed_at timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE notifications
  ADD CONSTRAINT chk_notifications_link_local
  CHECK (link = '' OR left(link, 1) = '/');

CREATE INDEX idx_class_items_course_week ON class_items(course_id, week);
CREATE INDEX idx_class_responses_item ON class_responses(item_id, student_id);
CREATE INDEX idx_course_snapshots_inst ON course_snapshots(institution_id, course_id);

DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.tables
    WHERE table_schema = 'storage' AND table_name = 'buckets'
  ) THEN
    INSERT INTO storage.buckets (id, name, public, file_size_limit)
    VALUES ('class-files', 'class-files', false, 20971520)
    ON CONFLICT (id) DO UPDATE SET public = false, file_size_limit = 20971520;
  END IF;
END $$;
