-- Sync faculty/recipient calendar when requesting a meeting, and ensure course faculty
-- are always included in list_hierarchy_contacts().

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

  -- Allow students/faculty to view availability/sessions of their hierarchy contacts (e.g. course faculty / HOD / Dean)
  IF EXISTS (
    SELECT 1 FROM public.enrollments e
    JOIN public.courses c ON c.id = e.course_id
    WHERE e.student_id = v_me.id AND c.faculty_id = v_target.id
  ) THEN
    RETURN true;
  END IF;

  IF public.has_role('faculty') AND (
    'hod' = ANY(CASE WHEN cardinality(v_target.roles) > 0 THEN v_target.roles ELSE ARRAY[v_target.role] END)
    OR 'dean' = ANY(CASE WHEN cardinality(v_target.roles) > 0 THEN v_target.roles ELSE ARRAY[v_target.role] END)
    OR 'coe' = ANY(CASE WHEN cardinality(v_target.roles) > 0 THEN v_target.roles ELSE ARRAY[v_target.role] END)
    OR 'vc' = ANY(CASE WHEN cardinality(v_target.roles) > 0 THEN v_target.roles ELSE ARRAY[v_target.role] END)
  ) THEN
    RETURN true;
  END IF;

  RETURN false;
END;
$$;

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
  v_is_overseer boolean := (
    v_target = auth.uid()
    OR public.has_role('super_admin')
    OR public.has_role('vc')
    OR public.has_role('coe')
    OR public.has_role('dean')
    OR public.has_role('hod')
  );
BEGIN
  IF NOT public.can_view_user_calendar(v_target) THEN
    RAISE EXCEPTION 'forbidden';
  END IF;

  RETURN QUERY
  SELECT
    m.id,
    CASE WHEN v_is_overseer THEN m.title ELSE 'Scheduled meeting'::text END AS title,
    CASE WHEN v_is_overseer THEN m.purpose ELSE ''::text END AS purpose,
    m.duration_minutes,
    m.scheduled_at,
    m.kind,
    m.status,
    CASE
      WHEN NOT v_is_overseer THEN 'Busy'::text
      WHEN m.requester_id = v_target THEN coalesce(rec.full_name, rec.email)
      ELSE coalesce(req.full_name, req.email)
    END AS other_name,
    CASE
      WHEN NOT v_is_overseer THEN ''::text
      WHEN m.requester_id = v_target THEN rec.role::text
      ELSE req.role::text
    END AS other_role,
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
    -- Student -> Course faculty of enrolled courses (request meeting)
    SELECT p.id, p.full_name, p.email, 'faculty'::text AS role, 'superior'::text AS relation
    FROM public.enrollments e
    JOIN public.courses c ON c.id = e.course_id
    JOIN public.profiles p ON p.id = c.faculty_id AND p.active = true
    WHERE public.has_role('student') AND e.student_id = v_me.id

    UNION ALL

    -- Faculty -> Enrolled students (schedule meeting / notify)
    SELECT p.id, p.full_name, p.email, 'student'::text AS role, 'subordinate'::text AS relation
    FROM public.courses c
    JOIN public.enrollments e ON e.course_id = c.id
    JOIN public.profiles p ON p.id = e.student_id AND p.active = true
    WHERE public.has_role('faculty') AND c.faculty_id = v_me.id

    UNION ALL

    -- Faculty -> HOD, Dean, CoE, VC in institution (request meeting)
    SELECT p.id, p.full_name, p.email,
      CASE
        WHEN 'vc' = ANY(CASE WHEN cardinality(p.roles) > 0 THEN p.roles ELSE ARRAY[p.role] END) THEN 'vc'
        WHEN 'coe' = ANY(CASE WHEN cardinality(p.roles) > 0 THEN p.roles ELSE ARRAY[p.role] END) THEN 'coe'
        WHEN 'dean' = ANY(CASE WHEN cardinality(p.roles) > 0 THEN p.roles ELSE ARRAY[p.role] END) THEN 'dean'
        ELSE 'hod'
      END AS role,
      'superior'::text AS relation
    FROM public.profiles p
    WHERE public.has_role('faculty')
      AND p.active = true
      AND p.id <> v_me.id
      AND (v_inst IS NULL OR p.institution_id = v_inst)
      AND (
        ('hod' = ANY(CASE WHEN cardinality(p.roles) > 0 THEN p.roles ELSE ARRAY[p.role] END)
          AND (v_me.department_id IS NULL OR COALESCE(p.hod_department_id, p.department_id) IS NULL OR COALESCE(p.hod_department_id, p.department_id) = v_me.department_id))
        OR 'dean' = ANY(CASE WHEN cardinality(p.roles) > 0 THEN p.roles ELSE ARRAY[p.role] END)
        OR 'coe' = ANY(CASE WHEN cardinality(p.roles) > 0 THEN p.roles ELSE ARRAY[p.role] END)
        OR 'vc' = ANY(CASE WHEN cardinality(p.roles) > 0 THEN p.roles ELSE ARRAY[p.role] END)
      )

    UNION ALL

    -- HOD -> Faculties in department OR course faculty teaching in HOD's department (schedule meeting / notify)
    SELECT p.id, p.full_name, p.email, 'faculty'::text AS role, 'subordinate'::text AS relation
    FROM public.profiles p
    WHERE public.has_role('hod')
      AND p.active = true
      AND p.id <> v_me.id
      AND (v_inst IS NULL OR p.institution_id = v_inst)
      AND (
        (
          (v_hod_dept IS NULL OR p.department_id IS NULL OR p.department_id = v_hod_dept)
          AND 'faculty' = ANY(CASE WHEN cardinality(p.roles) > 0 THEN p.roles ELSE ARRAY[p.role] END)
        )
        OR EXISTS (
          SELECT 1 FROM public.courses c
          WHERE c.faculty_id = p.id
            AND (v_hod_dept IS NULL OR c.department_id = v_hod_dept)
        )
      )

    UNION ALL

    -- HOD -> Dean, CoE, VC in institution (request meeting)
    SELECT p.id, p.full_name, p.email,
      CASE
        WHEN 'vc' = ANY(CASE WHEN cardinality(p.roles) > 0 THEN p.roles ELSE ARRAY[p.role] END) THEN 'vc'
        WHEN 'coe' = ANY(CASE WHEN cardinality(p.roles) > 0 THEN p.roles ELSE ARRAY[p.role] END) THEN 'coe'
        ELSE 'dean'
      END AS role,
      'superior'::text AS relation
    FROM public.profiles p
    WHERE public.has_role('hod')
      AND p.active = true
      AND p.id <> v_me.id
      AND (v_inst IS NULL OR p.institution_id = v_inst)
      AND (
        'dean' = ANY(CASE WHEN cardinality(p.roles) > 0 THEN p.roles ELSE ARRAY[p.role] END)
        OR 'coe' = ANY(CASE WHEN cardinality(p.roles) > 0 THEN p.roles ELSE ARRAY[p.role] END)
        OR 'vc' = ANY(CASE WHEN cardinality(p.roles) > 0 THEN p.roles ELSE ARRAY[p.role] END)
      )

    UNION ALL

    -- Dean -> HODs & Faculties in school/institution (schedule meeting / notify)
    SELECT p.id, p.full_name, p.email,
      CASE
        WHEN 'hod' = ANY(CASE WHEN cardinality(p.roles) > 0 THEN p.roles ELSE ARRAY[p.role] END) THEN 'hod'
        ELSE 'faculty'
      END AS role,
      'subordinate'::text AS relation
    FROM public.profiles p
    WHERE public.has_role('dean')
      AND p.active = true
      AND p.id <> v_me.id
      AND (v_inst IS NULL OR p.institution_id = v_inst)
      AND (
        v_dean_school IS NULL
        OR p.school_id = v_dean_school
        OR EXISTS (
          SELECT 1 FROM public.departments d
          WHERE d.id = COALESCE(p.hod_department_id, p.department_id)
            AND d.school_id = v_dean_school
        )
      )
      AND (
        'hod' = ANY(CASE WHEN cardinality(p.roles) > 0 THEN p.roles ELSE ARRAY[p.role] END)
        OR 'faculty' = ANY(CASE WHEN cardinality(p.roles) > 0 THEN p.roles ELSE ARRAY[p.role] END)
      )

    UNION ALL

    -- Dean -> CoE, VC in institution (request meeting)
    SELECT p.id, p.full_name, p.email,
      CASE WHEN 'vc' = ANY(CASE WHEN cardinality(p.roles) > 0 THEN p.roles ELSE ARRAY[p.role] END) THEN 'vc' ELSE 'coe' END AS role,
      'superior'::text AS relation
    FROM public.profiles p
    WHERE public.has_role('dean')
      AND p.active = true
      AND p.id <> v_me.id
      AND (v_inst IS NULL OR p.institution_id = v_inst)
      AND (
        'coe' = ANY(CASE WHEN cardinality(p.roles) > 0 THEN p.roles ELSE ARRAY[p.role] END)
        OR 'vc' = ANY(CASE WHEN cardinality(p.roles) > 0 THEN p.roles ELSE ARRAY[p.role] END)
      )

    UNION ALL

    -- CoE -> Deans, HODs, Faculties in institution (schedule meeting / notify)
    SELECT p.id, p.full_name, p.email, p.role::text AS role, 'subordinate'::text AS relation
    FROM public.profiles p
    WHERE public.has_role('coe')
      AND p.active = true
      AND p.id <> v_me.id
      AND (v_inst IS NULL OR p.institution_id = v_inst)
      AND (
        'dean' = ANY(CASE WHEN cardinality(p.roles) > 0 THEN p.roles ELSE ARRAY[p.role] END)
        OR 'hod' = ANY(CASE WHEN cardinality(p.roles) > 0 THEN p.roles ELSE ARRAY[p.role] END)
        OR 'faculty' = ANY(CASE WHEN cardinality(p.roles) > 0 THEN p.roles ELSE ARRAY[p.role] END)
      )

    UNION ALL

    -- CoE -> VC in institution (request meeting)
    SELECT p.id, p.full_name, p.email, 'vc'::text AS role, 'superior'::text AS relation
    FROM public.profiles p
    WHERE public.has_role('coe')
      AND p.active = true
      AND p.id <> v_me.id
      AND (v_inst IS NULL OR p.institution_id = v_inst)
      AND 'vc' = ANY(CASE WHEN cardinality(p.roles) > 0 THEN p.roles ELSE ARRAY[p.role] END)

    UNION ALL

    -- VC -> Deans, CoE, HODs, Faculties in institution (schedule meeting / notify)
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

GRANT EXECUTE ON FUNCTION can_view_user_calendar(uuid), calendar_approved_meetings(uuid), list_hierarchy_contacts() TO authenticated;
