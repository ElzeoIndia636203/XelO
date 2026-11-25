-- Phase 5: Workflows for classroom, reports, final marks pipeline, notifications, public verification, and personal calendar feed

-- Validate notification links strictly start with '/' when non-empty
CREATE OR REPLACE FUNCTION notify(
  p_user_id uuid,
  p_kind text,
  p_title text,
  p_body text DEFAULT '',
  p_link text DEFAULT '',
  p_institution_id uuid DEFAULT NULL
)
RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_inst uuid := p_institution_id;
  v_link text := trim(coalesce(p_link, ''));
  v_id uuid;
BEGIN
  IF v_link <> '' AND left(v_link, 1) <> '/' THEN
    RAISE EXCEPTION 'invalid_input';
  END IF;

  IF v_inst IS NULL THEN
    SELECT institution_id INTO v_inst FROM public.profiles WHERE id = p_user_id;
  END IF;
  IF v_inst IS NULL THEN
    RAISE EXCEPTION 'not_found';
  END IF;

  INSERT INTO public.notifications (institution_id, user_id, kind, title, body, link)
  VALUES (v_inst, p_user_id, p_kind, trim(p_title), coalesce(p_body, ''), v_link)
  RETURNING id INTO v_id;

  RETURN v_id;
END;
$$;

REVOKE ALL ON FUNCTION public.notify(uuid, text, text, text, text, uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.notify(uuid, text, text, text, text, uuid) TO service_role;

-- Update course plan submission & decision workflows to emit notifications
CREATE OR REPLACE FUNCTION submit_course_plan(p_course_id uuid)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_co public.courses%ROWTYPE;
  v_co_count integer;
  v_total integer;
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

  UPDATE public.courses
  SET plan_status = 'sent',
      plan_remark = NULL
  WHERE id = p_course_id;

  FOR v_hod IN
    SELECT DISTINCT p.id
    FROM public.profiles p
    WHERE p.institution_id = v_co.institution_id
      AND p.department_id = v_co.department_id
      AND p.role = 'hod'
      AND p.active = true
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
    jsonb_build_object('code', v_co.code, 'outcomes', v_co_count),
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

  IF my_role() <> 'hod'
     OR v_co.institution_id <> my_institution()
     OR v_co.department_id <> my_department()
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
    'plan_decision',
    CASE WHEN p_approve THEN 'Course plan approved: ' || v_co.code ELSE 'Course plan declined: ' || v_co.code END,
    COALESCE(v_remark, 'Approved by HOD.'),
    '/faculty/c/' || p_course_id::text || '/setup',
    v_co.institution_id
  );

  PERFORM public.audit(
    CASE WHEN p_approve THEN 'approve_course_plan' ELSE 'decline_course_plan' END,
    'course',
    p_course_id::text,
    jsonb_build_object('remark', v_remark, 'content_hash', v_hash),
    v_co.institution_id
  );
END;
$$;

-- Classroom items & server-side scoring
CREATE OR REPLACE FUNCTION create_class_item(
  p_course_id uuid,
  p_week integer,
  p_kind class_item_kind,
  p_task_type class_task_type DEFAULT NULL,
  p_title text DEFAULT '',
  p_body text DEFAULT '',
  p_payload jsonb DEFAULT '{}'::jsonb,
  p_due_at timestamptz DEFAULT NULL,
  p_url text DEFAULT NULL,
  p_file_path text DEFAULT NULL,
  p_answer_key jsonb DEFAULT NULL
)
RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_co public.courses%ROWTYPE;
  v_url text := nullif(trim(coalesce(p_url, '')), '');
  v_file text := nullif(trim(coalesce(p_file_path, '')), '');
  v_id uuid;
BEGIN
  IF NOT is_course_faculty(p_course_id) THEN
    RAISE EXCEPTION 'forbidden';
  END IF;

  SELECT * INTO v_co FROM public.courses WHERE id = p_course_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'not_found';
  END IF;

  IF p_week < 1 OR p_week > 30 OR trim(coalesce(p_title, '')) = '' THEN
    RAISE EXCEPTION 'invalid_input';
  END IF;

  IF (p_kind = 'task' AND p_task_type IS NULL) OR (p_kind <> 'task' AND p_task_type IS NOT NULL) THEN
    RAISE EXCEPTION 'invalid_input';
  END IF;

  IF v_url IS NOT NULL AND v_url !~* '^https://' THEN
    RAISE EXCEPTION 'invalid_input';
  END IF;

  IF v_file IS NOT NULL AND left(v_file, length(p_course_id::text) + 1) <> p_course_id::text || '/' THEN
    RAISE EXCEPTION 'forbidden';
  END IF;

  INSERT INTO public.class_items (
    institution_id, course_id, week, kind, task_type, title, body, payload, due_at, url, file_path, created_by
  )
  VALUES (
    v_co.institution_id,
    p_course_id,
    p_week,
    p_kind,
    p_task_type,
    trim(p_title),
    coalesce(p_body, ''),
    coalesce(p_payload, '{}'::jsonb),
    p_due_at,
    v_url,
    v_file,
    auth.uid()
  )
  RETURNING id INTO v_id;

  IF p_kind = 'task' THEN
    INSERT INTO public.class_answer_keys (item_id, institution_id, answer)
    VALUES (v_id, v_co.institution_id, coalesce(p_answer_key, '{}'::jsonb));
  END IF;

  PERFORM public.audit(
    'create_class_item',
    'class_item',
    v_id::text,
    jsonb_build_object('course_id', p_course_id, 'week', p_week, 'kind', p_kind::text),
    v_co.institution_id
  );

  RETURN v_id;
END;
$$;

CREATE OR REPLACE FUNCTION submit_class_response(
  p_item_id uuid,
  p_answer jsonb
)
RETURNS numeric
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_uid uuid := auth.uid();
  v_item public.class_items%ROWTYPE;
  v_key public.class_answer_keys%ROWTYPE;
  v_ans text;
  v_expected text;
  v_score numeric(5,2) := 0;
BEGIN
  SELECT * INTO v_item FROM public.class_items WHERE id = p_item_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'not_found';
  END IF;

  IF NOT is_course_student(v_item.course_id) THEN
    RAISE EXCEPTION 'forbidden';
  END IF;

  IF v_item.kind <> 'task' THEN
    RAISE EXCEPTION 'not_editable';
  END IF;

  v_ans := lower(regexp_replace(trim(coalesce(p_answer->>'value', '')), '\s+', ' ', 'g'));
  IF v_ans = '' THEN
    RAISE EXCEPTION 'invalid_input';
  END IF;

  SELECT * INTO v_key FROM public.class_answer_keys WHERE item_id = p_item_id;
  v_expected := lower(regexp_replace(trim(coalesce(v_key.answer->>'expected', '')), '\s+', ' ', 'g'));

  IF v_item.task_type = 'poll' THEN
    v_score := 1;
  ELSIF v_item.task_type = 'assignment' THEN
    v_score := 1;
  ELSIF v_item.task_type = 'debug' THEN
    IF (v_expected <> '' AND (v_ans = v_expected OR position(v_expected IN v_ans) > 0))
       OR EXISTS (
         SELECT 1
         FROM jsonb_array_elements_text(coalesce(v_key.answer->'accept', '[]'::jsonb)) AS alt
         WHERE lower(regexp_replace(trim(alt), '\s+', ' ', 'g')) <> ''
           AND position(lower(regexp_replace(trim(alt), '\s+', ' ', 'g')) IN v_ans) > 0
       ) THEN
      v_score := 1;
    ELSE
      v_score := 0;
    END IF;
  ELSE
    -- quiz, fill, predict
    v_score := CASE WHEN v_expected <> '' AND v_ans = v_expected THEN 1 ELSE 0 END;
  END IF;

  INSERT INTO public.class_responses (institution_id, item_id, student_id, answer, score, submitted_at)
  VALUES (v_item.institution_id, p_item_id, v_uid, coalesce(p_answer, '{}'::jsonb), v_score, now())
  ON CONFLICT (item_id, student_id)
  DO UPDATE SET answer = EXCLUDED.answer, score = EXCLUDED.score, submitted_at = now();

  RETURN v_score;
END;
$$;

-- Reports persistence (BoS notes & dashboard snapshots)
CREATE OR REPLACE FUNCTION save_course_notes(
  p_course_id uuid,
  p_bos_suggestions text,
  p_internal_summary text DEFAULT '',
  p_overall_summary text DEFAULT ''
)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_inst uuid;
BEGIN
  IF NOT is_course_faculty(p_course_id) THEN
    RAISE EXCEPTION 'forbidden';
  END IF;

  SELECT institution_id INTO v_inst FROM public.courses WHERE id = p_course_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'not_found';
  END IF;

  INSERT INTO public.course_notes (
    institution_id, course_id, bos_suggestions, internal_summary, overall_summary, updated_by, updated_at
  )
  VALUES (
    v_inst,
    p_course_id,
    coalesce(p_bos_suggestions, ''),
    coalesce(p_internal_summary, ''),
    coalesce(p_overall_summary, ''),
    auth.uid(),
    now()
  )
  ON CONFLICT (course_id)
  DO UPDATE SET
    bos_suggestions = EXCLUDED.bos_suggestions,
    internal_summary = EXCLUDED.internal_summary,
    overall_summary = EXCLUDED.overall_summary,
    updated_by = auth.uid(),
    updated_at = now();
END;
$$;

CREATE OR REPLACE FUNCTION save_course_snapshot(
  p_course_id uuid,
  p_students integer,
  p_internal_mean numeric,
  p_below_40 integer,
  p_co_internal jsonb,
  p_co_overall jsonb,
  p_overall_pct numeric
)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_inst uuid;
BEGIN
  IF NOT is_course_faculty(p_course_id) THEN
    RAISE EXCEPTION 'forbidden';
  END IF;

  SELECT institution_id INTO v_inst FROM public.courses WHERE id = p_course_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'not_found';
  END IF;

  INSERT INTO public.course_snapshots (
    institution_id, course_id, students, internal_mean, below_40, co_internal, co_overall, overall_pct, computed_at
  )
  VALUES (
    v_inst,
    p_course_id,
    greatest(0, p_students),
    coalesce(p_internal_mean, 0),
    greatest(0, p_below_40),
    coalesce(p_co_internal, '{}'::jsonb),
    coalesce(p_co_overall, '{}'::jsonb),
    coalesce(p_overall_pct, 0),
    now()
  )
  ON CONFLICT (course_id)
  DO UPDATE SET
    students = EXCLUDED.students,
    internal_mean = EXCLUDED.internal_mean,
    below_40 = EXCLUDED.below_40,
    co_internal = EXCLUDED.co_internal,
    co_overall = EXCLUDED.co_overall,
    overall_pct = EXCLUDED.overall_pct,
    computed_at = now();

  PERFORM public.audit(
    'save_course_snapshot',
    'course',
    p_course_id::text,
    jsonb_build_object('students', p_students, 'internal_mean', p_internal_mean, 'overall_pct', p_overall_pct),
    v_inst
  );
END;
$$;

-- Final marks pipeline: Faculty -> HOD -> CoE
CREATE OR REPLACE FUNCTION submit_final_marks(p_course_id uuid)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_co public.courses%ROWTYPE;
  v_hod RECORD;
BEGIN
  IF NOT is_course_faculty(p_course_id) THEN
    RAISE EXCEPTION 'forbidden';
  END IF;

  SELECT * INTO v_co FROM public.courses WHERE id = p_course_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'not_found';
  END IF;

  IF v_co.plan_status <> 'approved' THEN
    RAISE EXCEPTION 'plan_not_approved';
  END IF;

  IF v_co.final_status NOT IN ('none', 'draft', 'returned') THEN
    RAISE EXCEPTION 'not_editable';
  END IF;

  UPDATE public.courses
  SET final_status = 'sent'
  WHERE id = p_course_id;

  FOR v_hod IN
    SELECT DISTINCT p.id
    FROM public.profiles p
    WHERE p.institution_id = v_co.institution_id
      AND p.department_id = v_co.department_id
      AND p.role = 'hod'
      AND p.active = true
      AND p.id <> v_co.faculty_id
  LOOP
    PERFORM public.notify(
      v_hod.id,
      'final_marks_sent',
      'Final marks waiting: ' || v_co.code,
      v_co.title || ' final marks submitted for HOD review.',
      '/hod?tab=marks',
      v_co.institution_id
    );
  END LOOP;

  PERFORM public.audit(
    'submit_final_marks',
    'course',
    p_course_id::text,
    jsonb_build_object('code', v_co.code),
    v_co.institution_id
  );
END;
$$;

CREATE OR REPLACE FUNCTION decide_final_marks(
  p_course_id uuid,
  p_approve boolean,
  p_remark text DEFAULT NULL
)
RETURNS final_marks_status
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_co public.courses%ROWTYPE;
  v_role user_role := my_role();
  v_remark text := nullif(trim(coalesce(p_remark, '')), '');
  v_next final_marks_status;
  v_hash text;
  v_payload jsonb;
  v_coe RECORD;
  v_hod RECORD;
BEGIN
  SELECT * INTO v_co FROM public.courses WHERE id = p_course_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'not_found';
  END IF;

  IF v_co.institution_id <> my_institution() THEN
    RAISE EXCEPTION 'forbidden';
  END IF;

  IF v_co.final_status = 'sent' THEN
    IF v_role <> 'hod' OR v_co.department_id <> my_department() OR v_co.faculty_id = auth.uid() THEN
      RAISE EXCEPTION 'forbidden';
    END IF;
    IF NOT p_approve AND v_remark IS NULL THEN
      RAISE EXCEPTION 'remark_required';
    END IF;
    v_next := CASE WHEN p_approve THEN 'hod_approved'::final_marks_status ELSE 'returned'::final_marks_status END;
  ELSIF v_co.final_status = 'hod_approved' THEN
    IF v_role <> 'coe' THEN
      RAISE EXCEPTION 'forbidden';
    END IF;
    IF NOT p_approve AND v_remark IS NULL THEN
      RAISE EXCEPTION 'remark_required';
    END IF;
    v_next := CASE WHEN p_approve THEN 'coe_accepted'::final_marks_status ELSE 'returned'::final_marks_status END;
  ELSE
    RAISE EXCEPTION 'not_pending';
  END IF;

  SELECT jsonb_build_object(
    'course_id', v_co.id,
    'rubric', v_co.rubric,
    'attendance', coalesce((
      SELECT jsonb_agg(jsonb_build_object('s', a.student_id, 'st', a.state) ORDER BY a.student_id, a.at)
      FROM public.attendance a
      JOIN public.session_runs sr ON sr.id = a.session_run_id
      JOIN public.sessions s ON s.id = sr.session_id
      WHERE s.course_id = p_course_id
    ), '[]'::jsonb),
    'viva', coalesce((
      SELECT jsonb_agg(jsonb_build_object('s', v.student_id, 'sess', v.session_id, 'm', v.marks) ORDER BY v.student_id, v.session_id)
      FROM public.viva v
      JOIN public.sessions s ON s.id = v.session_id
      WHERE s.course_id = p_course_id
    ), '[]'::jsonb),
    'attempts', coalesce((
      SELECT jsonb_agg(jsonb_build_object('s', ta.student_id, 'b', ta.bank, 'sc', ta.score) ORDER BY ta.student_id, ta.session_id, ta.bank)
      FROM public.test_attempts ta
      JOIN public.sessions s ON s.id = ta.session_id
      WHERE s.course_id = p_course_id
    ), '[]'::jsonb)
  ) INTO v_payload;

  v_hash := encode(sha256(convert_to(v_payload::text, 'UTF8')), 'hex');

  UPDATE public.courses
  SET final_status = v_next
  WHERE id = p_course_id;

  INSERT INTO public.approvals (
    institution_id, object_type, object_id, approver_id, decision, remark, content_hash
  )
  VALUES (
    v_co.institution_id,
    'final_marks',
    p_course_id,
    auth.uid(),
    CASE WHEN p_approve THEN 'approved'::approval_decision ELSE 'returned'::approval_decision END,
    v_remark,
    v_hash
  );

  PERFORM public.notify(
    v_co.faculty_id,
    'final_marks_decision',
    CASE
      WHEN v_next = 'hod_approved' THEN 'Final marks approved by HOD: ' || v_co.code
      WHEN v_next = 'coe_accepted' THEN 'Final marks accepted by CoE: ' || v_co.code
      ELSE 'Final marks returned: ' || v_co.code
    END,
    COALESCE(v_remark, 'Status updated to ' || v_next::text),
    '/faculty/c/' || p_course_id::text || '/reports',
    v_co.institution_id
  );

  IF v_next = 'hod_approved' THEN
    FOR v_coe IN
      SELECT p.id FROM public.profiles p
      WHERE p.institution_id = v_co.institution_id AND p.role = 'coe' AND p.active = true
    LOOP
      PERFORM public.notify(
        v_coe.id,
        'final_marks_coe',
        'HOD-approved marks ready: ' || v_co.code,
        v_co.title || ' approved by HOD and ready for CoE acceptance.',
        '/oversight?tab=internals',
        v_co.institution_id
      );
    END LOOP;
  ELSIF v_next = 'returned' AND v_role = 'coe' THEN
    FOR v_hod IN
      SELECT p.id FROM public.profiles p
      WHERE p.institution_id = v_co.institution_id AND p.department_id = v_co.department_id AND p.role = 'hod' AND p.active = true
    LOOP
      PERFORM public.notify(
        v_hod.id,
        'final_marks_decision',
        'CoE returned final marks: ' || v_co.code,
        v_remark,
        '/hod?tab=marks',
        v_co.institution_id
      );
    END LOOP;
  END IF;

  PERFORM public.audit(
    CASE
      WHEN v_next = 'hod_approved' THEN 'hod_approve_final_marks'
      WHEN v_next = 'coe_accepted' THEN 'coe_accept_final_marks'
      ELSE 'return_final_marks'
    END,
    'course',
    p_course_id::text,
    jsonb_build_object('status', v_next::text, 'remark', v_remark, 'content_hash', v_hash),
    v_co.institution_id
  );

  RETURN v_next;
END;
$$;

-- Public QR verification helper (anon + authenticated): returns strictly non-sensitive record fields
CREATE OR REPLACE FUNCTION verify_lab_file(
  p_course_id uuid,
  p_student_id uuid
)
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_co public.courses%ROWTYPE;
  v_inst_name text;
  v_stu public.profiles%ROWTYPE;
  v_enr public.enrollments%ROWTYPE;
  v_sess RECORD;
  v_sess_count integer := 0;
  v_att_attended integer := 0;
  v_att_total integer := 0;
  v_raw_sum numeric := 0;
  v_att_mark numeric;
  v_pre_mark numeric;
  v_post_mark numeric;
  v_vis_mark numeric;
  v_hid_mark numeric;
  v_viva_mark numeric;
  v_att_pct integer := 0;
  v_internal integer := 0;
  v_code text;
BEGIN
  SELECT * INTO v_co FROM public.courses WHERE id = p_course_id;
  IF NOT FOUND THEN
    RETURN jsonb_build_object('found', false);
  END IF;

  SELECT * INTO v_enr FROM public.enrollments WHERE course_id = p_course_id AND student_id = p_student_id;
  IF NOT FOUND THEN
    RETURN jsonb_build_object('found', false);
  END IF;

  SELECT * INTO v_stu FROM public.profiles WHERE id = p_student_id AND active = true;
  IF NOT FOUND THEN
    RETURN jsonb_build_object('found', false);
  END IF;

  SELECT name INTO v_inst_name FROM public.institutions WHERE id = v_co.institution_id;

  FOR v_sess IN
    SELECT s.id
    FROM public.sessions s
    WHERE s.course_id = p_course_id AND s.status IN ('active', 'conducted')
  LOOP
    v_sess_count := v_sess_count + 1;

    -- Attendance for student in this session across their batch run
    SELECT
      CASE a.state
        WHEN 'present' THEN coalesce((v_co.rubric->>'att')::numeric, 10)
        WHEN 'late' THEN round(coalesce((v_co.rubric->>'att')::numeric, 10) * 0.5)
        ELSE 0
      END,
      CASE WHEN a.state IN ('present', 'late') THEN 1 ELSE 0 END,
      CASE WHEN a.id IS NOT NULL THEN 1 ELSE 0 END
    INTO v_att_mark, v_att_attended, v_vis_mark
    FROM public.session_runs sr
    LEFT JOIN public.attendance a ON a.session_run_id = sr.id AND a.student_id = p_student_id
    WHERE sr.session_id = v_sess.id AND sr.batch_id = v_enr.batch_id
    LIMIT 1;

    IF v_vis_mark = 1 THEN
      v_att_total := v_att_total + 1;
      IF v_att_attended = 1 THEN
        -- accumulate via reuse of v_att_mark / separate accumulator below
        NULL;
      END IF;
    END IF;

    SELECT round((coalesce(ta.score, 0)::numeric / 5.0) * coalesce((v_co.rubric->>'pre')::numeric, 5), 2)
    INTO v_pre_mark
    FROM public.test_attempts ta
    WHERE ta.session_id = v_sess.id AND ta.student_id = p_student_id AND ta.bank = 'pre';

    SELECT round((coalesce(ta.score, 0)::numeric / 5.0) * coalesce((v_co.rubric->>'post')::numeric, 5), 2)
    INTO v_post_mark
    FROM public.test_attempts ta
    WHERE ta.session_id = v_sess.id AND ta.student_id = p_student_id AND ta.bank = 'post';

    SELECT coalesce(round(avg(
      CASE WHEN best.vis_tot > 0 THEN (best.vis_pass::numeric / best.vis_tot) ELSE 0 END
    ) * coalesce((v_co.rubric->>'vis')::numeric, 10), 2), 0),
    coalesce(round(avg(
      CASE WHEN best.hid_tot > 0 THEN (best.hid_pass::numeric / best.hid_tot) ELSE 0 END
    ) * coalesce((v_co.rubric->>'hid')::numeric, 10), 2), 0)
    INTO v_vis_mark, v_hid_mark
    FROM (
      SELECT
        sq.question_id,
        coalesce(max(sub.visible_passed), 0) AS vis_pass,
        greatest(1, coalesce(max(sub.visible_total), 2)) AS vis_tot,
        coalesce(max(sub.hidden_passed), 0) AS hid_pass,
        greatest(1, coalesce(max(sub.hidden_total), 3)) AS hid_tot
      FROM public.session_questions sq
      LEFT JOIN public.submissions sub
        ON sub.question_id = sq.question_id AND sub.student_id = p_student_id AND sub.context = 'lab'
      WHERE sq.session_id = v_sess.id
      GROUP BY sq.question_id
    ) best;

    SELECT coalesce(v.marks, 0) INTO v_viva_mark
    FROM public.viva v
    WHERE v.session_id = v_sess.id AND v.student_id = p_student_id;

    v_raw_sum := v_raw_sum
      + coalesce(v_att_mark, 0)
      + coalesce(v_pre_mark, 0)
      + coalesce(v_post_mark, 0)
      + coalesce(v_vis_mark, 0)
      + coalesce(v_hid_mark, 0)
      + coalesce(v_viva_mark, 0);
  END LOOP;

  SELECT
    CASE WHEN count(*) > 0
      THEN round((count(*) FILTER (WHERE a.state IN ('present', 'late'))::numeric * 100) / count(*))::integer
      ELSE 0
    END
  INTO v_att_pct
  FROM public.attendance a
  JOIN public.session_runs sr ON sr.id = a.session_run_id
  JOIN public.sessions s ON s.id = sr.session_id
  WHERE s.course_id = p_course_id AND a.student_id = p_student_id;

  IF v_sess_count > 0 THEN
    v_internal := round((v_raw_sum / v_sess_count) * 2)::integer;
  END IF;

  v_code := 'XO-'
    || regexp_replace(upper(v_co.code), '[^A-Z0-9]', '', 'g')
    || '-'
    || coalesce(nullif(v_stu.roll_no, ''), left(v_stu.id::text, 6))
    || '-'
    || upper(substr(encode(sha256(convert_to(v_co.id::text || ':' || v_stu.id::text, 'UTF8')), 'hex'), 1, 4));

  RETURN jsonb_build_object(
    'found', true,
    'institution_name', coalesce(v_inst_name, ''),
    'course_code', v_co.code,
    'course_title', v_co.title,
    'academic_year', v_co.academic_year,
    'semester', v_co.semester,
    'student_name', v_stu.full_name,
    'roll_no', coalesce(v_stu.roll_no, ''),
    'attendance_pct', v_att_pct,
    'internal_out_of_100', least(100, greatest(0, v_internal)),
    'final_status', v_co.final_status::text,
    'verification_code', v_code
  );
END;
$$;

GRANT EXECUTE ON FUNCTION public.verify_lab_file(uuid, uuid) TO anon, authenticated;

-- Personal ICS calendar token rotation & service-only event lookup
CREATE OR REPLACE FUNCTION rotate_calendar_token()
RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_uid uuid := auth.uid();
  v_next uuid := gen_random_uuid();
BEGIN
  IF v_uid IS NULL THEN
    RAISE EXCEPTION 'forbidden';
  END IF;

  UPDATE public.profiles
  SET calendar_token = v_next
  WHERE id = v_uid AND active = true;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'forbidden';
  END IF;

  RETURN v_next;
END;
$$;

CREATE OR REPLACE FUNCTION calendar_events(p_token uuid)
RETURNS TABLE (
  uid text,
  summary text,
  description text,
  day date,
  location text
)
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_prof public.profiles%ROWTYPE;
BEGIN
  SELECT * INTO v_prof
  FROM public.profiles
  WHERE calendar_token = p_token AND active = true;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'invalid_token';
  END IF;

  IF v_prof.role = 'student' THEN
    RETURN QUERY
    SELECT
      'sess-' || s.id::text || '@xeio',
      co.code || ' · S' || s.n::text || ' ' || s.topic,
      co.title || ' (' || b.name || ' · ' || coalesce(b.slot, '') || ')',
      s.scheduled_date,
      coalesce(b.room, '')
    FROM public.enrollments e
    JOIN public.batches b ON b.id = e.batch_id
    JOIN public.courses co ON co.id = e.course_id
    JOIN public.sessions s ON s.course_id = co.id
    WHERE e.student_id = v_prof.id AND s.scheduled_date IS NOT NULL
    ORDER BY s.scheduled_date, s.n;
  ELSIF v_prof.role IN ('faculty', 'hod') THEN
    RETURN QUERY
    SELECT
      'sess-' || s.id::text || '@xeio',
      co.code || ' (' || co.section || ') · S' || s.n::text || ' ' || s.topic,
      co.title,
      s.scheduled_date,
      ''::text
    FROM public.courses co
    JOIN public.sessions s ON s.course_id = co.id
    WHERE (co.faculty_id = v_prof.id OR (v_prof.role = 'hod' AND co.department_id = v_prof.department_id))
      AND s.scheduled_date IS NOT NULL
    ORDER BY s.scheduled_date, s.n;
  ELSE
    RETURN QUERY
    SELECT
      'hol-' || h.id::text || '@xeio',
      'Holiday · ' || h.label,
      'Institutional holiday',
      h.day,
      ''::text
    FROM public.holidays h
    WHERE h.institution_id = v_prof.institution_id
    ORDER BY h.day;
  END IF;
END;
$$;

REVOKE ALL ON FUNCTION public.calendar_events(uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.calendar_events(uuid) TO service_role;
