-- Phase 1: Access helpers, RLS policies, privilege revokes, and column guards

CREATE OR REPLACE FUNCTION is_api_user()
RETURNS boolean
LANGUAGE sql
STABLE
AS $$
  SELECT current_user IN ('authenticated', 'anon');
$$;

CREATE OR REPLACE FUNCTION me()
RETURNS uuid
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT auth.uid();
$$;

CREATE OR REPLACE FUNCTION my_role()
RETURNS user_role
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT p.role
  FROM public.profiles p
  WHERE p.id = auth.uid() AND p.active = true;
$$;

CREATE OR REPLACE FUNCTION my_institution()
RETURNS uuid
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT p.institution_id
  FROM public.profiles p
  WHERE p.id = auth.uid() AND p.active = true;
$$;

CREATE OR REPLACE FUNCTION is_super_admin()
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT EXISTS (
    SELECT 1
    FROM public.profiles p
    WHERE p.id = auth.uid() AND p.active = true AND p.role = 'super_admin'
  );
$$;

-- Enable RLS everywhere (plain RLS, never FORCE ROW LEVEL SECURITY)
ALTER TABLE institutions ENABLE ROW LEVEL SECURITY;
ALTER TABLE schools ENABLE ROW LEVEL SECURITY;
ALTER TABLE departments ENABLE ROW LEVEL SECURITY;
ALTER TABLE profiles ENABLE ROW LEVEL SECURITY;
ALTER TABLE invites ENABLE ROW LEVEL SECURITY;
ALTER TABLE plans ENABLE ROW LEVEL SECURITY;
ALTER TABLE subscription_requests ENABLE ROW LEVEL SECURITY;
ALTER TABLE ai_runs ENABLE ROW LEVEL SECURITY;
ALTER TABLE approvals ENABLE ROW LEVEL SECURITY;
ALTER TABLE audit_log ENABLE ROW LEVEL SECURITY;

-- Default deny at privilege level
REVOKE ALL ON TABLE
  institutions,
  schools,
  departments,
  profiles,
  invites,
  plans,
  subscription_requests,
  ai_runs,
  approvals,
  audit_log
FROM anon, authenticated;

GRANT SELECT ON TABLE
  institutions,
  schools,
  departments,
  profiles,
  invites,
  plans,
  subscription_requests,
  ai_runs,
  approvals,
  audit_log
TO authenticated;

GRANT ALL ON TABLE
  institutions,
  schools,
  departments,
  profiles,
  invites,
  plans,
  subscription_requests,
  ai_runs,
  approvals,
  audit_log
TO service_role;

-- Read policies
CREATE POLICY institutions_read ON institutions
  FOR SELECT TO authenticated
  USING (is_super_admin() OR id = my_institution());

CREATE POLICY schools_read ON schools
  FOR SELECT TO authenticated
  USING (is_super_admin() OR institution_id = my_institution());

CREATE POLICY departments_read ON departments
  FOR SELECT TO authenticated
  USING (is_super_admin() OR institution_id = my_institution());

CREATE POLICY profiles_read ON profiles
  FOR SELECT TO authenticated
  USING (
    id = auth.uid()
    OR is_super_admin()
    OR (
      institution_id = my_institution()
      AND my_role() IN ('vc', 'coe', 'dean', 'hod', 'faculty')
    )
  );

CREATE POLICY invites_read ON invites
  FOR SELECT TO authenticated
  USING (
    is_super_admin()
    OR (
      institution_id = my_institution()
      AND my_role() IN ('vc', 'coe', 'dean', 'hod', 'faculty')
    )
  );

CREATE POLICY plans_read ON plans
  FOR SELECT TO authenticated
  USING (auth.uid() IS NOT NULL);

CREATE POLICY subscription_requests_read ON subscription_requests
  FOR SELECT TO authenticated
  USING (
    is_super_admin()
    OR (
      institution_id = my_institution()
      AND my_role() IN ('vc', 'coe', 'dean', 'hod', 'faculty')
    )
  );

CREATE POLICY ai_runs_read ON ai_runs
  FOR SELECT TO authenticated
  USING (
    is_super_admin()
    OR user_id = auth.uid()
    OR (
      institution_id = my_institution()
      AND my_role() IN ('vc', 'coe', 'dean', 'hod')
    )
  );

CREATE POLICY approvals_read ON approvals
  FOR SELECT TO authenticated
  USING (
    is_super_admin()
    OR (
      institution_id = my_institution()
      AND my_role() IN ('vc', 'coe', 'dean', 'hod', 'faculty')
    )
  );

CREATE POLICY audit_log_read ON audit_log
  FOR SELECT TO authenticated
  USING (
    is_super_admin()
    OR (
      institution_id = my_institution()
      AND my_role() IN ('vc', 'coe', 'dean', 'hod')
    )
  );

-- Column guard for profiles (one guard function per table)
CREATE OR REPLACE FUNCTION guard_profiles_update()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF is_api_user() THEN
    IF NEW.institution_id IS DISTINCT FROM OLD.institution_id
      OR NEW.email IS DISTINCT FROM OLD.email
      OR NEW.role IS DISTINCT FROM OLD.role
      OR NEW.school_id IS DISTINCT FROM OLD.school_id
      OR NEW.department_id IS DISTINCT FROM OLD.department_id
      OR NEW.roll_no IS DISTINCT FROM OLD.roll_no
      OR NEW.active IS DISTINCT FROM OLD.active
      OR NEW.plan_override IS DISTINCT FROM OLD.plan_override THEN
      RAISE EXCEPTION 'forbidden';
    END IF;
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER trg_guard_profiles_update
  BEFORE UPDATE ON profiles
  FOR EACH ROW
  EXECUTE FUNCTION guard_profiles_update();

-- Append-only enforcement on audit_log
CREATE OR REPLACE FUNCTION prevent_audit_mutation()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  RAISE EXCEPTION 'audit_immutable';
END;
$$;

CREATE TRIGGER trg_audit_log_immutable
  BEFORE UPDATE OR DELETE ON audit_log
  FOR EACH ROW
  EXECUTE FUNCTION prevent_audit_mutation();
