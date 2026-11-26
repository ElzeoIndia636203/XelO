-- Allow faculty to select one or multiple onboarded HODs for course plan approval
-- (e.g. when the same course is offered across multiple departments).

ALTER TABLE public.courses
  ADD COLUMN IF NOT EXISTS approval_hod_ids uuid[] NOT NULL DEFAULT '{}'::uuid[];

CREATE OR REPLACE FUNCTION list_institution_hods()
RETURNS TABLE (
  id uuid,
  full_name text,
  email text,
  department_id uuid,
  department_code text,
  department_name text
)
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_inst uuid := public.my_institution();
BEGIN
  IF v_inst IS NULL THEN
    RETURN;
  END IF;

  RETURN QUERY
  SELECT
    p.id,
    p.full_name,
    p.email,
    d.id AS department_id,
    coalesce(d.code, '') AS department_code,
    coalesce(d.name, '') AS department_name
  FROM public.profiles p
  LEFT JOIN public.departments d ON d.id = COALESCE(p.hod_department_id, p.department_id)
  WHERE p.active = true
    AND p.institution_id = v_inst
    AND 'hod' = ANY(CASE WHEN cardinality(p.roles) > 0 THEN p.roles ELSE ARRAY[p.role] END)
  ORDER BY d.code NULLS LAST, p.full_name;
END;
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
    JOIN public.profiles p ON p.id = auth.uid()
    WHERE co.id = c
      AND p.active = true
      AND (
        public.has_role('super_admin')
        OR (
          co.institution_id = p.institution_id
          AND (
            public.has_role('vc')
            OR public.has_role('coe')
            OR (
              public.has_role('dean')
              AND EXISTS (
                SELECT 1 FROM public.departments d
                WHERE d.id = co.department_id
                  AND d.school_id = COALESCE(p.dean_school_id, p.school_id)
              )
            )
            OR (
              public.has_role('hod')
              AND (
                co.department_id = COALESCE(p.hod_department_id, p.department_id)
                OR p.id = ANY(co.approval_hod_ids)
              )
            )
          )
        )
      )
  );
$$;

DROP FUNCTION IF EXISTS submit_course_plan(uuid);

CREATE OR REPLACE FUNCTION submit_course_plan(
  p_course_id uuid,
  p_hod_ids uuid[] DEFAULT NULL
)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_co public.courses%ROWTYPE;
  v_co_count integer;
  v_total integer;
  v_hod_ids uuid[];
  v_hod RECORD;
BEGIN
  IF NOT is_course_faculty(p_course_id) THEN
    RAISE EXCEPTION 'forbidden';
  END IF;

  SELECT * INTO v_co FROM public.courses WHERE id = p_course_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'not_found';
  END IF;
  IF v_co.plan_status NOT IN ('draft', 'declined') THEN
    RAISE EXCEPTION 'not_editable';
  END IF;

  SELECT count(*) INTO v_co_count FROM public.course_outcomes WHERE course_id = p_course_id;
  IF v_co_count < 1 THEN
    RAISE EXCEPTION 'outcomes_required';
  END IF;

  v_total :=
    COALESCE((v_co.rubric->>'att')::integer, 0)
    + COALESCE((v_co.rubric->>'pre')::integer, 0)
    + COALESCE((v_co.rubric->>'post')::integer, 0)
    + COALESCE((v_co.rubric->>'vis')::integer, 0)
    + COALESCE((v_co.rubric->>'hid')::integer, 0)
    + COALESCE((v_co.rubric->>'viva')::integer, 0);

  IF v_total <> 50 THEN
    RAISE EXCEPTION 'rubric_must_total_50';
  END IF;

  IF p_hod_ids IS NOT NULL AND coalesce(array_length(p_hod_ids, 1), 0) > 0 THEN
    SELECT ARRAY(
      SELECT DISTINCT p.id
      FROM public.profiles p
      WHERE p.id = ANY(p_hod_ids)
        AND p.institution_id = v_co.institution_id
        AND p.active = true
        AND 'hod' = ANY(CASE WHEN cardinality(p.roles) > 0 THEN p.roles ELSE ARRAY[p.role] END)
    ) INTO v_hod_ids;

    IF coalesce(array_length(v_hod_ids, 1), 0) = 0 THEN
      RAISE EXCEPTION 'invalid_input';
    END IF;
  ELSE
    SELECT ARRAY(
      SELECT DISTINCT p.id
      FROM public.profiles p
      WHERE p.institution_id = v_co.institution_id
        AND COALESCE(p.hod_department_id, p.department_id) = v_co.department_id
        AND 'hod' = ANY(CASE WHEN cardinality(p.roles) > 0 THEN p.roles ELSE ARRAY[p.role] END)
        AND p.active = true
    ) INTO v_hod_ids;
  END IF;

  UPDATE public.courses
  SET plan_status = 'sent',
      plan_remark = NULL,
      approval_hod_ids = coalesce(v_hod_ids, '{}'::uuid[])
  WHERE id = p_course_id;

  FOR v_hod IN
    SELECT DISTINCT p.id
    FROM public.profiles p
    WHERE p.id = ANY(coalesce(v_hod_ids, '{}'::uuid[]))
      AND p.id <> v_co.faculty_id
  LOOP
    PERFORM public.notify(
      v_hod.id,
      'plan_sent',
      'Course plan ready: ' || v_co.code,
      v_co.title || ' submitted for HOD approval.',
      '/hod?tab=approvals',
      v_co.institution_id
    );
  END LOOP;

  PERFORM public.audit(
    'submit_course_plan',
    'course',
    p_course_id::text,
    jsonb_build_object(
      'code', v_co.code,
      'outcomes', v_co_count,
      'approval_hod_ids', coalesce(v_hod_ids, '{}'::uuid[])
    ),
    v_co.institution_id
  );
END;
$$;

CREATE OR REPLACE FUNCTION decide_course_plan(
  p_course_id uuid,
  p_approve boolean,
  p_remark text DEFAULT NULL
)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_co public.courses%ROWTYPE;
  v_remark text := nullif(trim(coalesce(p_remark, '')), '');
  v_payload jsonb;
  v_hash text;
BEGIN
  SELECT * INTO v_co FROM public.courses WHERE id = p_course_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'not_found';
  END IF;

  IF NOT public.has_role('hod')
     OR v_co.institution_id <> my_institution()
     OR NOT (
       v_co.department_id = my_hod_department()
       OR auth.uid() = ANY(v_co.approval_hod_ids)
     )
     OR v_co.faculty_id = auth.uid() THEN
    RAISE EXCEPTION 'forbidden';
  END IF;

  IF v_co.plan_status <> 'sent' THEN
    RAISE EXCEPTION 'not_pending';
  END IF;

  IF NOT p_approve AND v_remark IS NULL THEN
    RAISE EXCEPTION 'remark_required';
  END IF;

  SELECT jsonb_build_object(
    'rubric', v_co.rubric,
    'outcomes', COALESCE((
      SELECT jsonb_agg(jsonb_build_object('code', o.code, 'statement', o.statement, 'btl', o.btl, 'unit', o.unit) ORDER BY o.code)
      FROM public.course_outcomes o WHERE o.course_id = p_course_id
    ), '[]'::jsonb),
    'map', COALESCE((
      SELECT jsonb_agg(jsonb_build_object('co_id', m.co_id, 'po_code', m.po_code, 'level', m.level) ORDER BY m.co_id, m.po_code)
      FROM public.co_po_map m WHERE m.course_id = p_course_id
    ), '[]'::jsonb)
  ) INTO v_payload;

  v_hash := encode(sha256(convert_to(v_payload::text, 'UTF8')), 'hex');

  UPDATE public.courses
  SET plan_status = CASE WHEN p_approve THEN 'approved'::plan_approval_status ELSE 'declined'::plan_approval_status END,
      plan_remark = v_remark
  WHERE id = p_course_id;

  INSERT INTO public.approvals (
    institution_id, object_type, object_id, approver_id, decision, remark, content_hash
  )
  VALUES (
    v_co.institution_id,
    'course_plan',
    p_course_id,
    auth.uid(),
    CASE WHEN p_approve THEN 'approved'::approval_decision ELSE 'declined'::approval_decision END,
    v_remark,
    v_hash
  );

  PERFORM public.notify(
    v_co.faculty_id,
    CASE WHEN p_approve THEN 'plan_approved' ELSE 'plan_declined' END,
    CASE WHEN p_approve THEN 'Course plan approved: ' ELSE 'Course plan declined: ' END || v_co.code,
    coalesce(v_remark, 'Your course plan is ' || CASE WHEN p_approve THEN 'approved.' ELSE 'returned.' END),
    '/faculty/c/' || v_co.id::text || '/setup',
    v_co.institution_id
  );

  PERFORM public.audit(
    CASE WHEN p_approve THEN 'approve_course_plan' ELSE 'decline_course_plan' END,
    'course',
    p_course_id::text,
    jsonb_build_object('code', v_co.code, 'hash', v_hash, 'remark', v_remark),
    v_co.institution_id
  );
END;
$$;

GRANT EXECUTE ON FUNCTION
  list_institution_hods(),
  submit_course_plan(uuid, uuid[]),
  decide_course_plan(uuid, boolean, text)
TO authenticated;
