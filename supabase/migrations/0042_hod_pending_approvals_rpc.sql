-- Reliable SECURITY DEFINER RPC for HOD pending approvals (including cross-department
-- courses sent via approval_hod_ids) and clean decision check for multi-role HODs.

CREATE OR REPLACE FUNCTION hod_pending_approvals()
RETURNS TABLE (
  id text,
  kind text,
  course_code text,
  course_title text,
  what text,
  age_hours numeric,
  entity_id uuid
)
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_inst uuid := public.my_institution();
  v_dept uuid := public.my_hod_department();
BEGIN
  IF NOT public.has_role('hod') AND NOT public.has_role('super_admin') THEN
    RAISE EXCEPTION 'forbidden';
  END IF;

  RETURN QUERY
  SELECT
    'plan-' || c.id::text AS id,
    'Course plan'::text AS kind,
    c.code AS course_code,
    c.title AS course_title,
    'Awaiting HOD approval'::text AS what,
    1::numeric AS age_hours,
    c.id AS entity_id
  FROM public.courses c
  WHERE c.institution_id = v_inst
    AND c.plan_status = 'sent'
    AND (
      public.has_role('super_admin')
      OR c.department_id = v_dept
      OR auth.uid() = ANY(c.approval_hod_ids)
    )

  UNION ALL

  SELECT
    'final-' || c.id::text AS id,
    'Final marks'::text AS kind,
    c.code AS course_code,
    c.title AS course_title,
    'Awaiting HOD approval & CoE submission'::text AS what,
    1::numeric AS age_hours,
    c.id AS entity_id
  FROM public.courses c
  WHERE c.institution_id = v_inst
    AND c.final_status = 'sent'
    AND (
      public.has_role('super_admin')
      OR c.department_id = v_dept
      OR auth.uid() = ANY(c.approval_hod_ids)
    )

  UNION ALL

  SELECT
    'endsem-' || a.id::text AS id,
    'End-sem set'::text AS kind,
    c.code AS course_code,
    c.title AS course_title,
    '30-question end-sem set awaiting HOD approval'::text AS what,
    1::numeric AS age_hours,
    a.id AS entity_id
  FROM public.assessments a
  JOIN public.courses c ON c.id = a.course_id
  WHERE c.institution_id = v_inst
    AND a.hod_status = 'sent'
    AND (
      public.has_role('super_admin')
      OR c.department_id = v_dept
      OR auth.uid() = ANY(c.approval_hod_ids)
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
     OR (v_co.faculty_id = auth.uid() AND NOT (auth.uid() = ANY(v_co.approval_hod_ids))) THEN
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

GRANT EXECUTE ON FUNCTION hod_pending_approvals(), decide_course_plan(uuid, boolean, text) TO authenticated;
