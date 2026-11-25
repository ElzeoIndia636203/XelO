-- Phase 2: Course access helpers, RLS policies, and per-table column/state guards

CREATE OR REPLACE FUNCTION my_department()
RETURNS uuid
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT p.department_id
  FROM public.profiles p
  WHERE p.id = auth.uid() AND p.active = true;
$$;

CREATE OR REPLACE FUNCTION my_school()
RETURNS uuid
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT p.school_id
  FROM public.profiles p
  WHERE p.id = auth.uid() AND p.active = true;
$$;

CREATE OR REPLACE FUNCTION is_course_faculty(c uuid)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT EXISTS (
    SELECT 1
    FROM public.courses co
    JOIN public.profiles p ON p.id = co.faculty_id
    WHERE co.id = c AND co.faculty_id = auth.uid() AND p.active = true
  );
$$;

CREATE OR REPLACE FUNCTION is_course_student(c uuid)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT EXISTS (
    SELECT 1
    FROM public.enrollments e
    JOIN public.profiles p ON p.id = e.student_id
    WHERE e.course_id = c AND e.student_id = auth.uid() AND p.active = true
  );
$$;

CREATE OR REPLACE FUNCTION can_oversee_course(c uuid)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT EXISTS (
    SELECT 1
    FROM public.courses co
    JOIN public.departments d ON d.id = co.department_id
    WHERE co.id = c
      AND (
        is_super_admin()
        OR (co.institution_id = my_institution() AND my_role() IN ('vc', 'coe'))
        OR (co.institution_id = my_institution() AND my_role() = 'dean' AND d.school_id = my_school())
        OR (co.institution_id = my_institution() AND my_role() = 'hod' AND co.department_id = my_department())
      )
  );
$$;

CREATE OR REPLACE FUNCTION can_read_course(c uuid)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT is_course_faculty(c) OR is_course_student(c) OR can_oversee_course(c);
$$;

ALTER TABLE courses ENABLE ROW LEVEL SECURITY;
ALTER TABLE course_outcomes ENABLE ROW LEVEL SECURITY;
ALTER TABLE co_po_map ENABLE ROW LEVEL SECURITY;
ALTER TABLE batches ENABLE ROW LEVEL SECURITY;
ALTER TABLE enrollments ENABLE ROW LEVEL SECURITY;
ALTER TABLE pending_enrollments ENABLE ROW LEVEL SECURITY;
ALTER TABLE sessions ENABLE ROW LEVEL SECURITY;
ALTER TABLE holidays ENABLE ROW LEVEL SECURITY;

REVOKE ALL ON TABLE
  courses,
  course_outcomes,
  co_po_map,
  batches,
  enrollments,
  pending_enrollments,
  sessions,
  holidays
FROM anon, authenticated;

GRANT SELECT ON TABLE
  courses,
  course_outcomes,
  co_po_map,
  batches,
  enrollments,
  pending_enrollments,
  sessions,
  holidays
TO authenticated;

GRANT INSERT, UPDATE, DELETE ON TABLE
  courses,
  course_outcomes,
  co_po_map
TO authenticated;

GRANT UPDATE (slot, room, staff) ON TABLE batches TO authenticated;

GRANT ALL ON TABLE
  courses,
  course_outcomes,
  co_po_map,
  batches,
  enrollments,
  pending_enrollments,
  sessions,
  holidays
TO service_role;

-- Courses policies (select includes faculty_id = auth.uid() for INSERT RETURNING)
CREATE POLICY courses_read ON courses
  FOR SELECT TO authenticated
  USING (faculty_id = auth.uid() OR is_course_student(id) OR can_oversee_course(id));

CREATE POLICY courses_insert ON courses
  FOR INSERT TO authenticated
  WITH CHECK (
    faculty_id = auth.uid()
    AND institution_id = my_institution()
    AND my_role() IN ('faculty', 'hod')
  );

CREATE POLICY courses_update ON courses
  FOR UPDATE TO authenticated
  USING (faculty_id = auth.uid())
  WITH CHECK (faculty_id = auth.uid());

CREATE POLICY courses_delete ON courses
  FOR DELETE TO authenticated
  USING (faculty_id = auth.uid() AND plan_status = 'draft');

-- Outcomes and CO-PO map policies
CREATE POLICY course_outcomes_read ON course_outcomes
  FOR SELECT TO authenticated
  USING (can_read_course(course_id));

CREATE POLICY course_outcomes_insert ON course_outcomes
  FOR INSERT TO authenticated
  WITH CHECK (is_course_faculty(course_id));

CREATE POLICY course_outcomes_update ON course_outcomes
  FOR UPDATE TO authenticated
  USING (is_course_faculty(course_id))
  WITH CHECK (is_course_faculty(course_id));

CREATE POLICY course_outcomes_delete ON course_outcomes
  FOR DELETE TO authenticated
  USING (is_course_faculty(course_id));

CREATE POLICY co_po_map_read ON co_po_map
  FOR SELECT TO authenticated
  USING (can_read_course(course_id));

CREATE POLICY co_po_map_insert ON co_po_map
  FOR INSERT TO authenticated
  WITH CHECK (is_course_faculty(course_id));

CREATE POLICY co_po_map_update ON co_po_map
  FOR UPDATE TO authenticated
  USING (is_course_faculty(course_id))
  WITH CHECK (is_course_faculty(course_id));

CREATE POLICY co_po_map_delete ON co_po_map
  FOR DELETE TO authenticated
  USING (is_course_faculty(course_id));

-- Batches, enrollments, pending_enrollments, sessions, holidays
CREATE POLICY batches_read ON batches
  FOR SELECT TO authenticated
  USING (can_read_course(course_id));

CREATE POLICY batches_update ON batches
  FOR UPDATE TO authenticated
  USING (is_course_faculty(course_id))
  WITH CHECK (is_course_faculty(course_id));

CREATE POLICY enrollments_read ON enrollments
  FOR SELECT TO authenticated
  USING (
    student_id = auth.uid()
    OR is_course_faculty(course_id)
    OR can_oversee_course(course_id)
  );

CREATE POLICY pending_enrollments_read ON pending_enrollments
  FOR SELECT TO authenticated
  USING (is_course_faculty(course_id) OR can_oversee_course(course_id));

CREATE POLICY sessions_read ON sessions
  FOR SELECT TO authenticated
  USING (can_read_course(course_id));

CREATE POLICY holidays_read ON holidays
  FOR SELECT TO authenticated
  USING (is_super_admin() OR institution_id = my_institution());

-- Guard triggers (one function per table)
CREATE OR REPLACE FUNCTION guard_courses()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF NOT is_api_user() THEN
    RETURN NEW;
  END IF;

  IF TG_OP = 'INSERT' THEN
    IF NEW.plan_status <> 'draft' OR NEW.final_status <> 'none' OR NEW.plan_remark IS NOT NULL THEN
      RAISE EXCEPTION 'forbidden';
    END IF;
    RETURN NEW;
  END IF;

  IF TG_OP = 'UPDATE' THEN
    IF NEW.plan_status IS DISTINCT FROM OLD.plan_status
       OR NEW.final_status IS DISTINCT FROM OLD.final_status
       OR NEW.plan_remark IS DISTINCT FROM OLD.plan_remark
       OR NEW.faculty_id IS DISTINCT FROM OLD.faculty_id
       OR NEW.institution_id IS DISTINCT FROM OLD.institution_id
       OR NEW.department_id IS DISTINCT FROM OLD.department_id THEN
      RAISE EXCEPTION 'forbidden';
    END IF;

    IF OLD.plan_status IN ('sent', 'approved') THEN
      RAISE EXCEPTION 'plan_locked';
    END IF;

    IF OLD.plan_status = 'declined' THEN
      NEW.plan_status := 'draft';
      NEW.plan_remark := NULL;
    END IF;
    RETURN NEW;
  END IF;

  RETURN NEW;
END;
$$;

CREATE TRIGGER trg_guard_courses
  BEFORE INSERT OR UPDATE ON courses
  FOR EACH ROW
  EXECUTE FUNCTION guard_courses();

CREATE OR REPLACE FUNCTION reopen_declined_course(p_course_id uuid)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  IF is_course_faculty(p_course_id) THEN
    UPDATE public.courses
    SET plan_status = 'draft', plan_remark = NULL
    WHERE id = p_course_id AND plan_status = 'declined';
  END IF;
END;
$$;

REVOKE ALL ON FUNCTION public.reopen_declined_course(uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.reopen_declined_course(uuid) TO authenticated;

CREATE OR REPLACE FUNCTION guard_course_outcomes()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  v_cid uuid;
  v_status plan_approval_status;
BEGIN
  IF NOT is_api_user() THEN
    RETURN COALESCE(NEW, OLD);
  END IF;

  v_cid := COALESCE(NEW.course_id, OLD.course_id);
  SELECT plan_status INTO v_status FROM public.courses WHERE id = v_cid;
  IF v_status IN ('sent', 'approved') THEN
    RAISE EXCEPTION 'plan_locked';
  END IF;
  IF v_status = 'declined' THEN
    PERFORM public.reopen_declined_course(v_cid);
  END IF;
  RETURN COALESCE(NEW, OLD);
END;
$$;

CREATE TRIGGER trg_guard_course_outcomes
  BEFORE INSERT OR UPDATE OR DELETE ON course_outcomes
  FOR EACH ROW
  EXECUTE FUNCTION guard_course_outcomes();

CREATE OR REPLACE FUNCTION guard_co_po_map()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  v_cid uuid;
  v_status plan_approval_status;
BEGIN
  IF NOT is_api_user() THEN
    RETURN COALESCE(NEW, OLD);
  END IF;

  v_cid := COALESCE(NEW.course_id, OLD.course_id);
  SELECT plan_status INTO v_status FROM public.courses WHERE id = v_cid;
  IF v_status IN ('sent', 'approved') THEN
    RAISE EXCEPTION 'plan_locked';
  END IF;
  IF v_status = 'declined' THEN
    PERFORM public.reopen_declined_course(v_cid);
  END IF;
  RETURN COALESCE(NEW, OLD);
END;
$$;

CREATE TRIGGER trg_guard_co_po_map
  BEFORE INSERT OR UPDATE OR DELETE ON co_po_map
  FOR EACH ROW
  EXECUTE FUNCTION guard_co_po_map();

CREATE OR REPLACE FUNCTION guard_batches()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF is_api_user() THEN
    IF NEW.class_code IS DISTINCT FROM OLD.class_code
       OR NEW.name IS DISTINCT FROM OLD.name
       OR NEW.course_id IS DISTINCT FROM OLD.course_id
       OR NEW.institution_id IS DISTINCT FROM OLD.institution_id THEN
      RAISE EXCEPTION 'forbidden';
    END IF;
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER trg_guard_batches
  BEFORE UPDATE ON batches
  FOR EACH ROW
  EXECUTE FUNCTION guard_batches();

CREATE OR REPLACE FUNCTION guard_sessions()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF is_api_user() THEN
    RAISE EXCEPTION 'forbidden';
  END IF;
  RETURN COALESCE(NEW, OLD);
END;
$$;

CREATE TRIGGER trg_guard_sessions
  BEFORE INSERT OR UPDATE OR DELETE ON sessions
  FOR EACH ROW
  EXECUTE FUNCTION guard_sessions();
