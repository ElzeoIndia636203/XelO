-- Allow an active HOD to approve/decline any course plan in my_hod_department()
-- or routed via approval_hod_ids, even if the HOD also holds the faculty role on that course
-- (e.g. legacy courses created before approval_hod_ids existed). Non-HOD faculty remain blocked.

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
     ) THEN
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

GRANT EXECUTE ON FUNCTION decide_course_plan(uuid, boolean, text) TO authenticated;
