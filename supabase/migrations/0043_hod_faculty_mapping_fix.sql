-- Ensure hod_faculty_summary resolves HOD department via hod_department_id, department_id,
-- or departments.hod_id, and includes faculties in that department, courses in that department,
-- and courses routed to this HOD via approval_hod_ids.

CREATE OR REPLACE FUNCTION my_hod_department()
RETURNS uuid
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT COALESCE(
    p.hod_department_id,
    p.department_id,
    (SELECT d.id FROM public.departments d WHERE d.hod_id = p.id LIMIT 1)
  )
  FROM public.profiles p
  WHERE p.id = auth.uid();
$$;

CREATE OR REPLACE FUNCTION hod_faculty_summary(p_department_id uuid DEFAULT NULL)
RETURNS TABLE (
  faculty_id uuid,
  faculty_name text,
  faculty_email text,
  course_id uuid,
  course_code text,
  course_title text,
  sessions_total integer,
  sessions_conducted integer,
  missed_classes integer,
  streak integer,
  attendance_pct numeric,
  avg_score_pct numeric
)
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_me public.profiles%ROWTYPE;
  v_dept uuid;
BEGIN
  SELECT * INTO v_me FROM public.profiles WHERE id = auth.uid() AND active = true;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'forbidden';
  END IF;

  IF NOT (
    public.has_role('hod')
    OR public.has_role('dean')
    OR public.has_role('coe')
    OR public.has_role('vc')
    OR public.has_role('super_admin')
  ) THEN
    RAISE EXCEPTION 'forbidden';
  END IF;

  v_dept := COALESCE(
    p_department_id,
    v_me.hod_department_id,
    v_me.department_id,
    (SELECT d.id FROM public.departments d WHERE d.hod_id = v_me.id LIMIT 1)
  );

  RETURN QUERY
  SELECT
    p.id AS faculty_id,
    p.full_name AS faculty_name,
    p.email AS faculty_email,
    c.id AS course_id,
    COALESCE(c.code, '—') AS course_code,
    COALESCE(c.title, 'No courses assigned yet') AS course_title,
    CASE WHEN c.id IS NULL THEN 0 ELSE (SELECT count(*)::integer FROM public.sessions s WHERE s.course_id = c.id) END AS sessions_total,
    CASE WHEN c.id IS NULL THEN 0 ELSE (SELECT count(*)::integer FROM public.sessions s WHERE s.course_id = c.id AND s.status = 'conducted') END AS sessions_conducted,
    CASE WHEN c.id IS NULL THEN 0 ELSE (
      SELECT count(*)::integer FROM public.sessions s
      WHERE s.course_id = c.id
        AND s.scheduled_date IS NOT NULL
        AND s.scheduled_date < (now() AT TIME ZONE 'Asia/Kolkata')::date
        AND s.status <> 'conducted'
    ) END AS missed_classes,
    CASE WHEN c.id IS NULL THEN 0 ELSE COALESCE((
      SELECT count(*)::integer
      FROM public.sessions s
      WHERE s.course_id = c.id
        AND s.status = 'conducted'
        AND s.n > COALESCE((
          SELECT max(s2.n)
          FROM public.sessions s2
          WHERE s2.course_id = c.id
            AND s2.scheduled_date IS NOT NULL
            AND s2.scheduled_date < (now() AT TIME ZONE 'Asia/Kolkata')::date
            AND s2.status <> 'conducted'
        ), 0)
    ), 0) END AS streak,
    CASE WHEN c.id IS NULL THEN 0::numeric ELSE COALESCE((
      SELECT round(100.0 * count(*) FILTER (WHERE a.state IN ('present', 'late')) / NULLIF(count(*), 0), 1)
      FROM public.attendance a
      JOIN public.session_runs sr ON sr.id = a.session_run_id
      JOIN public.sessions s ON s.id = sr.session_id
      WHERE s.course_id = c.id
    ), 0)::numeric END AS attendance_pct,
    CASE WHEN c.id IS NULL THEN 0::numeric ELSE COALESCE((
      SELECT round(avg(CASE WHEN sub.hidden_total > 0 AND sub.hidden_passed = sub.hidden_total THEN 100.0 ELSE 0.0 END), 1)
      FROM public.submissions sub
      JOIN public.sessions s ON s.id = sub.session_id
      WHERE s.course_id = c.id AND sub.mode = 'submit'
    ), 0)::numeric END AS avg_score_pct
  FROM public.profiles p
  LEFT JOIN public.courses c ON c.faculty_id = p.id
  WHERE p.active = true
    AND (public.has_role('super_admin') OR p.institution_id = v_me.institution_id)
    AND (
      (v_dept IS NOT NULL AND c.department_id = v_dept)
      OR (v_me.id = ANY(coalesce(c.approval_hod_ids, '{}'::uuid[])))
      OR (
        (v_dept IS NULL OR p.department_id = v_dept)
        AND 'faculty' = ANY(CASE WHEN cardinality(p.roles) > 0 THEN p.roles ELSE ARRAY[p.role] END)
      )
    )
  ORDER BY p.full_name, c.code NULLS LAST;
END;
$$;

GRANT EXECUTE ON FUNCTION my_hod_department(), hod_faculty_summary(uuid) TO authenticated;
