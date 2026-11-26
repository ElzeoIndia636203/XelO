-- Restore list_hierarchy_contacts relation values ('superior'/'subordinate') with role-scoped dept/school,
-- and add HOD-authorized calendar_approved_meetings(p_user_id) + faculty_calendar_sessions(p_user_id).

DROP FUNCTION IF EXISTS list_hierarchy_contacts();

CREATE OR REPLACE FUNCTION list_hierarchy_contacts()
RETURNS TABLE (
  id uuid,
  full_name text,
  email text,
  role text,
  relation text
)
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_me public.profiles%ROWTYPE;
  v_inst uuid;
  v_hod_dept uuid;
  v_dean_school uuid;
BEGIN
  SELECT * INTO v_me FROM public.profiles WHERE id = auth.uid() AND active = true;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'forbidden';
  END IF;

  v_inst := coalesce(
    v_me.institution_id,
    (SELECT c.institution_id FROM public.courses c WHERE c.faculty_id = v_me.id LIMIT 1)
  );
  v_hod_dept := COALESCE(v_me.hod_department_id, v_me.department_id);
  v_dean_school := COALESCE(v_me.dean_school_id, v_me.school_id);

  RETURN QUERY
  SELECT DISTINCT ON (t.id, t.relation)
    t.id, t.full_name, t.email, t.role, t.relation
  FROM (
    -- Student -> Faculty of enrolled courses (request meeting)
    SELECT p.id, p.full_name, p.email, p.role::text AS role, 'superior'::text AS relation
    FROM public.enrollments e
    JOIN public.courses c ON c.id = e.course_id
    JOIN public.profiles p ON p.id = c.faculty_id AND p.active = true
    WHERE public.has_role('student') AND e.student_id = v_me.id

    UNION ALL

    -- Faculty -> Enrolled students (notify / schedule meeting)
    SELECT p.id, p.full_name, p.email, p.role::text AS role, 'subordinate'::text AS relation
    FROM public.courses c
    JOIN public.enrollments e ON e.course_id = c.id
    JOIN public.profiles p ON p.id = e.student_id AND p.active = true
    WHERE public.has_role('faculty') AND c.faculty_id = v_me.id

    UNION ALL

    -- Faculty -> HOD, Dean, CoE, VC (request meeting)
    SELECT p.id, p.full_name, p.email, p.role::text AS role, 'superior'::text AS relation
    FROM public.profiles p
    WHERE public.has_role('faculty')
      AND p.active = true
      AND p.id <> v_me.id
      AND (v_inst IS NULL OR p.institution_id = v_inst)
      AND (
        ('hod' = ANY(CASE WHEN cardinality(p.roles) > 0 THEN p.roles ELSE ARRAY[p.role] END)
          AND (v_me.department_id IS NULL OR COALESCE(p.hod_department_id, p.department_id) IS NULL OR COALESCE(p.hod_department_id, p.department_id) = v_me.department_id))
        OR ('dean' = ANY(CASE WHEN cardinality(p.roles) > 0 THEN p.roles ELSE ARRAY[p.role] END)
          AND (v_me.school_id IS NULL OR COALESCE(p.dean_school_id, p.school_id) IS NULL OR COALESCE(p.dean_school_id, p.school_id) = v_me.school_id))
        OR 'coe' = ANY(CASE WHEN cardinality(p.roles) > 0 THEN p.roles ELSE ARRAY[p.role] END)
        OR 'vc' = ANY(CASE WHEN cardinality(p.roles) > 0 THEN p.roles ELSE ARRAY[p.role] END)
      )

    UNION ALL

    -- HOD -> Faculties grouped under HOD's finalized department (notify / schedule meeting)
    SELECT p.id, p.full_name, p.email, p.role::text AS role, 'subordinate'::text AS relation
    FROM public.profiles p
    WHERE public.has_role('hod')
      AND p.active = true
      AND p.id <> v_me.id
      AND (v_inst IS NULL OR p.institution_id = v_inst)
      AND (v_hod_dept IS NULL OR p.department_id IS NULL OR p.department_id = v_hod_dept)
      AND 'faculty' = ANY(CASE WHEN cardinality(p.roles) > 0 THEN p.roles ELSE ARRAY[p.role] END)

    UNION ALL

    -- HOD -> Dean, CoE, VC (request meeting)
    SELECT p.id, p.full_name, p.email, p.role::text AS role, 'superior'::text AS relation
    FROM public.profiles p
    WHERE public.has_role('hod')
      AND p.active = true
      AND p.id <> v_me.id
      AND (v_inst IS NULL OR p.institution_id = v_inst)
      AND (
        ('dean' = ANY(CASE WHEN cardinality(p.roles) > 0 THEN p.roles ELSE ARRAY[p.role] END)
          AND (v_me.school_id IS NULL OR COALESCE(p.dean_school_id, p.school_id) IS NULL OR COALESCE(p.dean_school_id, p.school_id) = v_me.school_id))
        OR 'coe' = ANY(CASE WHEN cardinality(p.roles) > 0 THEN p.roles ELSE ARRAY[p.role] END)
        OR 'vc' = ANY(CASE WHEN cardinality(p.roles) > 0 THEN p.roles ELSE ARRAY[p.role] END)
      )

    UNION ALL

    -- Dean -> HODs in school (notify / schedule meeting)
    SELECT p.id, p.full_name, p.email, p.role::text AS role, 'subordinate'::text AS relation
    FROM public.profiles p
    WHERE public.has_role('dean')
      AND p.active = true
      AND p.id <> v_me.id
      AND (v_inst IS NULL OR p.institution_id = v_inst)
      AND (
        v_dean_school IS NULL
        OR EXISTS (
          SELECT 1 FROM public.departments d
          WHERE d.id = COALESCE(p.hod_department_id, p.department_id)
            AND d.school_id = v_dean_school
        )
      )
      AND 'hod' = ANY(CASE WHEN cardinality(p.roles) > 0 THEN p.roles ELSE ARRAY[p.role] END)

    UNION ALL

    -- CoE -> Deans in institution
    SELECT p.id, p.full_name, p.email, p.role::text AS role, 'subordinate'::text AS relation
    FROM public.profiles p
    WHERE public.has_role('coe')
      AND p.active = true
      AND p.id <> v_me.id
      AND (v_inst IS NULL OR p.institution_id = v_inst)
      AND 'dean' = ANY(CASE WHEN cardinality(p.roles) > 0 THEN p.roles ELSE ARRAY[p.role] END)

    UNION ALL

    -- VC -> Staff in institution
    SELECT p.id, p.full_name, p.email, p.role::text AS role, 'subordinate'::text AS relation
    FROM public.profiles p
    WHERE public.has_role('vc')
      AND p.active = true
      AND p.id <> v_me.id
      AND (v_inst IS NULL OR p.institution_id = v_inst)
      AND NOT ('student' = ANY(CASE WHEN cardinality(p.roles) > 0 THEN p.roles ELSE ARRAY[p.role] END))
  ) t
  ORDER BY t.id, t.relation, t.full_name;
END;
$$;

CREATE OR REPLACE FUNCTION can_view_user_calendar(p_target_id uuid)
RETURNS boolean
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_me public.profiles%ROWTYPE;
  v_target public.profiles%ROWTYPE;
  v_hod_dept uuid;
  v_dean_school uuid;
BEGIN
  IF p_target_id IS NULL OR p_target_id = auth.uid() THEN
    RETURN true;
  END IF;

  SELECT * INTO v_me FROM public.profiles WHERE id = auth.uid() AND active = true;
  IF NOT FOUND THEN RETURN false; END IF;

  IF public.has_role('super_admin') THEN
    RETURN true;
  END IF;

  SELECT * INTO v_target FROM public.profiles WHERE id = p_target_id AND active = true;
  IF NOT FOUND THEN RETURN false; END IF;

  IF v_target.institution_id IS DISTINCT FROM v_me.institution_id THEN
    RETURN false;
  END IF;

  IF public.has_role('vc') OR public.has_role('coe') THEN
    RETURN true;
  END IF;

  v_dean_school := COALESCE(v_me.dean_school_id, v_me.school_id);
  IF public.has_role('dean') AND v_dean_school IS NOT NULL THEN
    IF v_target.school_id = v_dean_school THEN RETURN true; END IF;
  END IF;

  v_hod_dept := COALESCE(v_me.hod_department_id, v_me.department_id);
  IF public.has_role('hod') AND v_hod_dept IS NOT NULL THEN
    IF v_target.department_id = v_hod_dept THEN RETURN true; END IF;
    IF EXISTS (
      SELECT 1 FROM public.courses c
      WHERE c.faculty_id = v_target.id AND c.department_id = v_hod_dept
    ) THEN
      RETURN true;
    END IF;
  END IF;

  RETURN false;
END;
$$;

DROP FUNCTION IF EXISTS calendar_approved_meetings();

CREATE OR REPLACE FUNCTION calendar_approved_meetings(p_user_id uuid DEFAULT NULL)
RETURNS TABLE (
  id uuid,
  title text,
  purpose text,
  duration_minutes integer,
  scheduled_at timestamptz,
  kind text,
  status text,
  other_name text,
  other_role text,
  is_requester boolean
)
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_target uuid := COALESCE(p_user_id, auth.uid());
BEGIN
  IF NOT public.can_view_user_calendar(v_target) THEN
    RAISE EXCEPTION 'forbidden';
  END IF;

  RETURN QUERY
  SELECT
    m.id,
    m.title,
    m.purpose,
    m.duration_minutes,
    m.scheduled_at,
    m.kind,
    m.status,
    CASE WHEN m.requester_id = v_target THEN coalesce(rec.full_name, rec.email) ELSE coalesce(req.full_name, req.email) END AS other_name,
    CASE WHEN m.requester_id = v_target THEN rec.role::text ELSE req.role::text END AS other_role,
    (m.requester_id = v_target) AS is_requester
  FROM public.meetings m
  LEFT JOIN public.profiles req ON req.id = m.requester_id
  LEFT JOIN public.profiles rec ON rec.id = m.recipient_id
  WHERE (m.requester_id = v_target OR m.recipient_id = v_target)
    AND m.scheduled_at IS NOT NULL
    AND (m.status = 'accepted' OR (m.kind = 'meeting_scheduled' AND m.status = 'sent'))
  ORDER BY m.scheduled_at ASC;
END;
$$;

CREATE OR REPLACE FUNCTION faculty_calendar_sessions(p_user_id uuid DEFAULT NULL)
RETURNS TABLE (
  session_id uuid,
  course_id uuid,
  course_code text,
  course_title text,
  session_n integer,
  session_title text,
  scheduled_date date,
  status text
)
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_target uuid := COALESCE(p_user_id, auth.uid());
BEGIN
  IF NOT public.can_view_user_calendar(v_target) THEN
    RAISE EXCEPTION 'forbidden';
  END IF;

  RETURN QUERY
  SELECT
    s.id AS session_id,
    c.id AS course_id,
    c.code AS course_code,
    c.title AS course_title,
    s.n AS session_n,
    s.title AS session_title,
    s.scheduled_date,
    s.status::text AS status
  FROM public.sessions s
  JOIN public.courses c ON c.id = s.course_id
  WHERE c.faculty_id = v_target
    AND s.scheduled_date IS NOT NULL
  ORDER BY s.scheduled_date ASC, c.code ASC, s.n ASC;
END;
$$;

GRANT EXECUTE ON FUNCTION
  list_hierarchy_contacts(),
  can_view_user_calendar(uuid),
  calendar_approved_meetings(uuid),
  faculty_calendar_sessions(uuid)
TO authenticated;
