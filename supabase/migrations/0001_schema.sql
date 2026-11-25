-- Phase 1: Core organisation, people, plans, AI runs, approvals, and audit schema

CREATE TYPE user_role AS ENUM (
  'super_admin',
  'vc',
  'coe',
  'dean',
  'hod',
  'faculty',
  'student'
);

CREATE TYPE plan_tier AS ENUM ('pro', 'elite');

CREATE TYPE subscription_status AS ENUM ('sent', 'approved', 'rejected');

CREATE TYPE approval_decision AS ENUM ('approved', 'declined', 'returned');

CREATE TABLE institutions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name text NOT NULL,
  email_domain text NOT NULL UNIQUE,
  plan plan_tier,
  plan_start date,
  plan_end date,
  min_attendance_pct integer NOT NULL DEFAULT 75 CHECK (min_attendance_pct BETWEEN 0 AND 100),
  attainment_threshold_pct integer NOT NULL DEFAULT 60 CHECK (attainment_threshold_pct BETWEEN 0 AND 100),
  level_1_pct integer NOT NULL DEFAULT 60 CHECK (level_1_pct BETWEEN 0 AND 100),
  level_2_pct integer NOT NULL DEFAULT 70 CHECK (level_2_pct BETWEEN 0 AND 100),
  level_3_pct integer NOT NULL DEFAULT 80 CHECK (level_3_pct BETWEEN 0 AND 100),
  internal_weight numeric(4,2) NOT NULL DEFAULT 0.40,
  endsem_weight numeric(4,2) NOT NULL DEFAULT 0.60,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE schools (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  institution_id uuid NOT NULL REFERENCES institutions(id) ON DELETE CASCADE,
  name text NOT NULL,
  dean_id uuid,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (institution_id, name)
);

CREATE TABLE departments (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  institution_id uuid NOT NULL REFERENCES institutions(id) ON DELETE CASCADE,
  school_id uuid NOT NULL REFERENCES schools(id) ON DELETE CASCADE,
  code text NOT NULL,
  name text NOT NULL,
  hod_id uuid,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (institution_id, code)
);

CREATE TABLE profiles (
  id uuid PRIMARY KEY REFERENCES auth.users(id) ON DELETE CASCADE,
  institution_id uuid REFERENCES institutions(id) ON DELETE SET NULL,
  email text NOT NULL UNIQUE,
  full_name text NOT NULL,
  role user_role NOT NULL,
  school_id uuid REFERENCES schools(id) ON DELETE SET NULL,
  department_id uuid REFERENCES departments(id) ON DELETE SET NULL,
  roll_no text,
  active boolean NOT NULL DEFAULT true,
  plan_override plan_tier,
  calendar_token uuid NOT NULL DEFAULT gen_random_uuid(),
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE invites (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  email text NOT NULL UNIQUE,
  institution_id uuid REFERENCES institutions(id) ON DELETE CASCADE,
  role user_role NOT NULL,
  full_name text NOT NULL,
  school_id uuid REFERENCES schools(id) ON DELETE SET NULL,
  department_id uuid REFERENCES departments(id) ON DELETE SET NULL,
  roll_no text,
  created_by uuid REFERENCES profiles(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  accepted_at timestamptz,
  CONSTRAINT invites_institution_required CHECK (role = 'super_admin' OR institution_id IS NOT NULL)
);

CREATE TABLE plans (
  tier plan_tier PRIMARY KEY,
  total_cap integer NOT NULL CHECK (total_cap >= 0),
  daily_cap integer NOT NULL CHECK (daily_cap >= 1)
);

INSERT INTO plans (tier, total_cap, daily_cap)
VALUES ('pro', 125, 5), ('elite', 250, 7)
ON CONFLICT (tier) DO NOTHING;

CREATE TABLE subscription_requests (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  institution_id uuid NOT NULL REFERENCES institutions(id) ON DELETE CASCADE,
  requested_by uuid REFERENCES profiles(id) ON DELETE SET NULL,
  scope_label text NOT NULL DEFAULT '',
  plan plan_tier NOT NULL REFERENCES plans(tier),
  start_date date NOT NULL,
  months integer NOT NULL CHECK (months IN (3, 6, 12)),
  status subscription_status NOT NULL DEFAULT 'sent',
  decided_by uuid REFERENCES profiles(id) ON DELETE SET NULL,
  decided_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE ai_runs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  institution_id uuid NOT NULL REFERENCES institutions(id) ON DELETE CASCADE,
  user_id uuid NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
  feature text NOT NULL,
  course_id uuid,
  status text NOT NULL DEFAULT 'started',
  charged boolean NOT NULL DEFAULT true,
  at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE approvals (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  institution_id uuid NOT NULL REFERENCES institutions(id) ON DELETE CASCADE,
  object_type text NOT NULL,
  object_id uuid NOT NULL,
  approver_id uuid NOT NULL REFERENCES profiles(id) ON DELETE RESTRICT,
  decision approval_decision NOT NULL,
  remark text,
  content_hash text NOT NULL,
  at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE audit_log (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  institution_id uuid REFERENCES institutions(id) ON DELETE SET NULL,
  actor_id uuid REFERENCES profiles(id) ON DELETE SET NULL,
  action text NOT NULL,
  object_type text NOT NULL,
  object_id text,
  detail jsonb NOT NULL DEFAULT '{}'::jsonb,
  at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX idx_profiles_institution ON profiles(institution_id);
CREATE INDEX idx_profiles_email_lower ON profiles(lower(email));
CREATE INDEX idx_invites_email_lower ON invites(lower(email));
CREATE INDEX idx_ai_runs_user_at ON ai_runs(user_id, at DESC);
CREATE INDEX idx_approvals_inst_obj ON approvals(institution_id, object_type, object_id);
CREATE INDEX idx_audit_log_inst_at ON audit_log(institution_id, at DESC);
