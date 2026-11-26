-- SECURITY DEFINER RPC for HOD to preview a full course plan package
-- (details, COs, CO-PO map, rubric, faculty & department info) before approving/declining.

CREATE OR REPLACE FUNCTION hod_course_plan_preview(p_course_id uuid)
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_co public.courses%ROWTYPE;
  v_dept_name text := '';
  v_fac_name text := '';
  v_fac_email text := '';
  v_outcomes jsonb := '[]'::jsonb;
  v_map jsonb := '[]'::jsonb;
  v_sessions_count integer := 0;
BEGIN
  IF NOT (
    public.has_role('hod')
    OR public.has_role('dean')
    OR public.has_role('coe')
    OR public.has_role('vc')
    OR public.has_role('super_admin')
  ) THEN
    RAISE EXCEPTION 'forbidden';
  END IF;

  SELECT * INTO v_co FROM public.courses WHERE id = p_course_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'not_found';
  END IF;

  IF NOT public.can_oversee_course(p_course_id) THEN
    RAISE EXCEPTION 'forbidden';
  END IF;

  SELECT name INTO v_dept_name FROM public.departments WHERE id = v_co.department_id;
  SELECT full_name, email INTO v_fac_name, v_fac_email FROM public.profiles WHERE id = v_co.faculty_id;

  SELECT COALESCE(
    jsonb_agg(
      jsonb_build_object(
        'id', o.id,
        'code', o.code,
        'statement', o.statement,
        'unit', o.unit,
        'btl', o.btl
      ) ORDER BY o.code
    ),
    '[]'::jsonb
  )
  INTO v_outcomes
  FROM public.course_outcomes o
  WHERE o.course_id = p_course_id;

  SELECT COALESCE(
    jsonb_agg(
      jsonb_build_object(
        'co_id', m.co_id,
        'po_code', m.po_code,
        'level', m.level
      ) ORDER BY m.co_id, m.po_code
    ),
    '[]'::jsonb
  )
  INTO v_map
  FROM public.co_po_map m
  WHERE m.course_id = p_course_id;

  SELECT count(*)::integer INTO v_sessions_count FROM public.sessions WHERE course_id = p_course_id;

  RETURN jsonb_build_object(
    'course', jsonb_build_object(
      'id', v_co.id,
      'code', v_co.code,
      'title', v_co.title,
      'ltpc', v_co.ltpc,
      'programme', v_co.programme,
      'semester', v_co.semester,
      'section', v_co.section,
      'academic_year', v_co.academic_year,
      'allowed_langs', v_co.allowed_langs,
      'rubric', v_co.rubric,
      'plan_status', v_co.plan_status,
      'plan_remark', v_co.plan_remark,
      'department_name', coalesce(v_dept_name, ''),
      'faculty_name', coalesce(v_fac_name, ''),
      'faculty_email', coalesce(v_fac_email, '')
    ),
    'outcomes', v_outcomes,
    'co_po_map', v_map,
    'sessions_count', v_sessions_count
  );
END;
$$;

GRANT EXECUTE ON FUNCTION hod_course_plan_preview(uuid) TO authenticated;
