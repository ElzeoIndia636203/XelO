-- =============================================================
-- 0020 End-sem practical workflows & authorize_run exam extension
-- =============================================================

-- ── create_assessment ────────────────────────────────────────────────────

CREATE OR REPLACE FUNCTION create_assessment(
  p_course_id uuid,
  p_batch_id uuid,
  p_rules jsonb,
  p_cos uuid[]
)
RETURNS uuid
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public
AS $$
DECLARE
  v_inst uuid;
  v_id uuid;
  v_locked boolean;
  v_qps int := coalesce((p_rules->>'questions_per_student')::int, 0);
  v_easy int := coalesce((p_rules->'mix'->>'easy')::int, 0);
  v_med int := coalesce((p_rules->'mix'->>'medium')::int, 0);
  v_hard int := coalesce((p_rules->'mix'->>'hard')::int, 0);
  v_vis int := coalesce((p_rules->>'visible_count')::int, 0);
  v_hid int := coalesce((p_rules->>'hidden_count')::int, 0);
  v_mpt int := coalesce((p_rules->>'marks_per_test')::int, 0);
  v_viva int := coalesce((p_rules->>'viva_marks')::int, -1);
  v_dur int := coalesce((p_rules->>'duration_min')::int, 0);
  v_co_cnt int;
BEGIN
  IF NOT is_course_faculty(p_course_id) THEN
    RAISE EXCEPTION 'forbidden';
  END IF;

  IF p_cos IS NULL OR cardinality(p_cos) < 1 THEN
    RAISE EXCEPTION 'need_co';
  END IF;

  SELECT count(*)::int INTO v_co_cnt
    FROM course_outcomes
   WHERE course_id = p_course_id AND id = ANY(p_cos);
  IF v_co_cnt <> cardinality(p_cos) THEN
    RAISE EXCEPTION 'invalid_co';
  END IF;

  IF (v_easy + v_med + v_hard) <> 40
     OR v_easy < 0 OR v_med < 0 OR v_hard < 0
     OR v_qps < 1 OR v_vis < 1 OR v_hid < 1
     OR v_mpt <= 0 OR v_viva < 0 OR v_dur <= 0 THEN
    RAISE EXCEPTION 'invalid_rules';
  END IF;

  SELECT institution_id INTO v_inst FROM courses WHERE id = p_course_id;

  SELECT id, rules_locked INTO v_id, v_locked
    FROM assessments
   WHERE course_id = p_course_id AND batch_id = p_batch_id;

  IF FOUND THEN
    IF v_locked THEN
      RAISE EXCEPTION 'rules_locked';
    END IF;
    UPDATE assessments
       SET rules = p_rules, cos = p_cos
     WHERE id = v_id;
  ELSE
    INSERT INTO assessments (institution_id, course_id, batch_id, rules, cos, stage)
    VALUES (v_inst, p_course_id, p_batch_id, p_rules, p_cos, 'rules')
    RETURNING id INTO v_id;
  END IF;

  PERFORM public.audit(
    'save_assessment_rules',
    'assessment',
    v_id::text,
    jsonb_build_object('course_id', p_course_id, 'batch_id', p_batch_id),
    v_inst
  );

  RETURN v_id;
END;
$$;

-- ── register_endsem_candidates (used by edge function / faculty) ─────────

CREATE OR REPLACE FUNCTION pick_assessment_questions(
  p_assessment_id uuid,
  p_question_ids uuid[]
)
RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public
AS $$
DECLARE
  v_a assessments%ROWTYPE;
BEGIN
  SELECT * INTO v_a FROM assessments WHERE id = p_assessment_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'not_found'; END IF;
  IF NOT is_course_faculty(v_a.course_id) THEN RAISE EXCEPTION 'forbidden'; END IF;
  IF v_a.stage NOT IN ('rules', 'generate') THEN RAISE EXCEPTION 'not_editable'; END IF;

  UPDATE assessment_questions
     SET approved = (question_id = ANY(coalesce(p_question_ids, ARRAY[]::uuid[])))
   WHERE assessment_id = p_assessment_id;

  UPDATE assessments
     SET stage = 'generate', rules_locked = true
   WHERE id = p_assessment_id AND stage = 'rules';
END;
$$;

-- ── send_assessment_to_hod ───────────────────────────────────────────────

CREATE OR REPLACE FUNCTION send_assessment_to_hod(p_assessment_id uuid)
RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public
AS $$
DECLARE
  v_a assessments%ROWTYPE;
  v_c courses%ROWTYPE;
  v_app_cnt int;
  v_inv_cnt int;
  v_min_co int;
  v_hod record;
BEGIN
  SELECT * INTO v_a FROM assessments WHERE id = p_assessment_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'not_found'; END IF;
  IF NOT is_course_faculty(v_a.course_id) THEN RAISE EXCEPTION 'forbidden'; END IF;
  IF v_a.stage NOT IN ('rules', 'generate') THEN RAISE EXCEPTION 'not_editable'; END IF;

  SELECT count(*)::int,
         count(*) FILTER (WHERE coalesce(q.valid, false) = false)::int
    INTO v_app_cnt, v_inv_cnt
    FROM assessment_questions aq
    JOIN questions q ON q.id = aq.question_id
   WHERE aq.assessment_id = p_assessment_id
     AND aq.approved = true;

  IF v_app_cnt <> 30 THEN
    RAISE EXCEPTION 'need_30_approved';
  END IF;
  IF v_inv_cnt > 0 THEN
    RAISE EXCEPTION 'invalid_question';
  END IF;

  -- Check >= 4 approved questions per selected CO
  SELECT coalesce(min(cnt), 0) INTO v_min_co
  FROM (
    SELECT co.code,
           (SELECT count(*)::int
              FROM assessment_questions aq
              JOIN questions q ON q.id = aq.question_id
             WHERE aq.assessment_id = p_assessment_id
               AND aq.approved = true
               AND q.co_code = co.code) AS cnt
      FROM course_outcomes co
     WHERE co.id = ANY(v_a.cos)
  ) sub;

  IF v_min_co < 4 THEN
    RAISE EXCEPTION 'min_4_per_co';
  END IF;

  UPDATE assessments
     SET stage = 'hod_pending',
         hod_status = 'sent',
         hod_remark = null,
         rules_locked = true
   WHERE id = p_assessment_id;

  SELECT * INTO v_c FROM courses WHERE id = v_a.course_id;

  FOR v_hod IN
    SELECT DISTINCT p.id
      FROM profiles p
     WHERE p.institution_id = v_c.institution_id
       AND p.department_id = v_c.department_id
       AND p.role = 'hod'
       AND p.active = true
       AND p.id <> v_c.faculty_id
  LOOP
    PERFORM public.notify(
      v_hod.id,
      'endsem_sent',
      'End-sem set ready: ' || v_c.code,
      v_c.title || ' end-sem 30-question set submitted for HOD approval.',
      '/hod?tab=approvals',
      v_c.institution_id
    );
  END LOOP;

  PERFORM public.audit(
    'send_assessment_to_hod',
    'assessment',
    p_assessment_id::text,
    jsonb_build_object('course_id', v_a.course_id, 'approved_count', v_app_cnt),
    v_a.institution_id
  );
END;
$$;

-- ── decide_assessment ────────────────────────────────────────────────────

CREATE OR REPLACE FUNCTION decide_assessment(
  p_assessment_id uuid,
  p_approve boolean,
  p_remark text DEFAULT NULL
)
RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public
AS $$
DECLARE
  v_a assessments%ROWTYPE;
  v_c courses%ROWTYPE;
  v_remark text := nullif(trim(coalesce(p_remark, '')), '');
  v_hash text;
BEGIN
  SELECT * INTO v_a FROM assessments WHERE id = p_assessment_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'not_found'; END IF;

  SELECT * INTO v_c FROM courses WHERE id = v_a.course_id;
  IF my_role() <> 'hod'
     OR v_c.institution_id <> my_institution()
     OR v_c.department_id <> my_department()
     OR v_c.faculty_id = auth.uid() THEN
    RAISE EXCEPTION 'forbidden';
  END IF;

  IF v_a.stage <> 'hod_pending' OR v_a.hod_status <> 'sent' THEN
    RAISE EXCEPTION 'not_pending';
  END IF;

  IF NOT p_approve AND v_remark IS NULL THEN
    RAISE EXCEPTION 'remark_required';
  END IF;

  v_hash := md5(coalesce((
    SELECT string_agg(question_id::text, ',' ORDER BY question_id)
      FROM assessment_questions
     WHERE assessment_id = p_assessment_id AND approved = true
  ), ''));

  INSERT INTO approvals (institution_id, object_type, object_id, approver_id, decision, remark, content_hash)
  VALUES (
    v_a.institution_id,
    'assessment',
    p_assessment_id,
    auth.uid(),
    CASE WHEN p_approve THEN 'approved'::approval_decision ELSE 'declined'::approval_decision END,
    v_remark,
    v_hash
  );

  IF p_approve THEN
    UPDATE assessments
       SET stage = 'scheduled',
           hod_status = 'approved',
           hod_remark = v_remark
     WHERE id = p_assessment_id;
  ELSE
    UPDATE assessments
       SET stage = 'generate',
           hod_status = 'declined',
           hod_remark = v_remark
     WHERE id = p_assessment_id;
  END IF;

  PERFORM public.notify(
    v_c.faculty_id,
    CASE WHEN p_approve THEN 'endsem_approved' ELSE 'endsem_declined' END,
    'End-sem set ' || CASE WHEN p_approve THEN 'approved' ELSE 'returned' END || ': ' || v_c.code,
    coalesce(v_remark, 'Approved by HOD.'),
    '/faculty/c/' || v_c.id::text || '/assessments',
    v_c.institution_id
  );

  PERFORM public.audit(
    CASE WHEN p_approve THEN 'approve_assessment' ELSE 'decline_assessment' END,
    'assessment',
    p_assessment_id::text,
    jsonb_build_object('remark', v_remark, 'hash', v_hash),
    v_a.institution_id
  );
END;
$$;

-- ── schedule_assessment ──────────────────────────────────────────────────

CREATE OR REPLACE FUNCTION schedule_assessment(
  p_assessment_id uuid,
  p_at timestamptz,
  p_room text
)
RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public
AS $$
DECLARE
  v_a assessments%ROWTYPE;
  v_c courses%ROWTYPE;
  v_stu record;
BEGIN
  SELECT * INTO v_a FROM assessments WHERE id = p_assessment_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'not_found'; END IF;
  IF NOT is_course_faculty(v_a.course_id) THEN RAISE EXCEPTION 'forbidden'; END IF;
  IF v_a.hod_status <> 'approved' OR v_a.stage NOT IN ('scheduled', 'live') THEN
    RAISE EXCEPTION 'not_approved';
  END IF;
  IF p_at IS NULL OR length(trim(coalesce(p_room, ''))) = 0 THEN
    RAISE EXCEPTION 'invalid_input';
  END IF;

  UPDATE assessments
     SET scheduled_at = p_at,
         room = trim(p_room)
   WHERE id = p_assessment_id;

  SELECT * INTO v_c FROM courses WHERE id = v_a.course_id;

  FOR v_stu IN
    SELECT e.student_id FROM enrollments e
     WHERE e.course_id = v_a.course_id AND e.batch_id = v_a.batch_id
  LOOP
    PERFORM public.notify(
      v_stu.student_id,
      'endsem_scheduled',
      'End-sem scheduled: ' || v_c.code,
      'Room ' || trim(p_room) || ' on ' || to_char(p_at AT TIME ZONE 'Asia/Kolkata', 'DD Mon YYYY HH24:MI'),
      '/student/endsem',
      v_a.institution_id
    );
  END LOOP;

  PERFORM public.audit(
    'schedule_assessment',
    'assessment',
    p_assessment_id::text,
    jsonb_build_object('scheduled_at', p_at, 'room', trim(p_room)),
    v_a.institution_id
  );
END;
$$;

-- ── save_exam_attendance ─────────────────────────────────────────────────

CREATE OR REPLACE FUNCTION save_exam_attendance(
  p_assessment_id uuid,
  p_entries jsonb
)
RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public
AS $$
DECLARE
  v_a assessments%ROWTYPE;
  v_item jsonb;
  v_sid uuid;
  v_state attendance_state;
BEGIN
  SELECT * INTO v_a FROM assessments WHERE id = p_assessment_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'not_found'; END IF;
  IF NOT is_course_faculty(v_a.course_id) THEN RAISE EXCEPTION 'forbidden'; END IF;
  IF v_a.hod_status <> 'approved' THEN RAISE EXCEPTION 'not_approved'; END IF;

  FOR v_item IN SELECT * FROM jsonb_array_elements(coalesce(p_entries, '[]'::jsonb))
  LOOP
    v_sid := (v_item->>'student_id')::uuid;
    v_state := (v_item->>'state')::attendance_state;

    IF NOT EXISTS (
      SELECT 1 FROM enrollments e
       WHERE e.course_id = v_a.course_id AND e.batch_id = v_a.batch_id AND e.student_id = v_sid
    ) THEN
      RAISE EXCEPTION 'not_in_batch';
    END IF;

    INSERT INTO attendance (institution_id, assessment_id, student_id, state, marked_by)
    VALUES (v_a.institution_id, p_assessment_id, v_sid, v_state, auth.uid())
    ON CONFLICT (assessment_id, student_id) WHERE assessment_id IS NOT NULL
    DO UPDATE SET state = excluded.state, marked_by = auth.uid(), at = now();
  END LOOP;

  UPDATE assessments SET attendance_done = true WHERE id = p_assessment_id;

  PERFORM public.audit(
    'save_exam_attendance',
    'assessment',
    p_assessment_id::text,
    jsonb_build_object('count', jsonb_array_length(coalesce(p_entries, '[]'::jsonb))),
    v_a.institution_id
  );
END;
$$;

-- ── activate_assessment ──────────────────────────────────────────────────

CREATE OR REPLACE FUNCTION activate_assessment(p_assessment_id uuid)
RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public
AS $$
DECLARE
  v_a assessments%ROWTYPE;
BEGIN
  SELECT * INTO v_a FROM assessments WHERE id = p_assessment_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'not_found'; END IF;
  IF NOT is_course_faculty(v_a.course_id) THEN RAISE EXCEPTION 'forbidden'; END IF;
  IF v_a.hod_status <> 'approved' THEN RAISE EXCEPTION 'not_approved'; END IF;
  IF NOT v_a.attendance_done THEN RAISE EXCEPTION 'attendance_required'; END IF;

  UPDATE assessments
     SET stage = 'live',
         activated_at = coalesce(activated_at, now())
   WHERE id = p_assessment_id;

  PERFORM public.audit(
    'activate_assessment',
    'assessment',
    p_assessment_id::text,
    '{}'::jsonb,
    v_a.institution_id
  );
END;
$$;

-- ── start_exam ───────────────────────────────────────────────────────────

CREATE OR REPLACE FUNCTION start_exam(p_assessment_id uuid)
RETURNS exam_papers
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public
AS $$
DECLARE
  v_a assessments%ROWTYPE;
  v_paper exam_papers%ROWTYPE;
  v_att attendance_state;
  v_qps int;
  v_dur int;
  v_q_ids uuid[];
  v_deadline timestamptz;
BEGIN
  SELECT * INTO v_a FROM assessments WHERE id = p_assessment_id;
  IF NOT FOUND THEN RAISE EXCEPTION 'not_found'; END IF;
  IF v_a.stage <> 'live' OR v_a.activated_at IS NULL OR v_a.ended_at IS NOT NULL THEN
    RAISE EXCEPTION 'exam_not_active';
  END IF;

  SELECT state INTO v_att
    FROM attendance
   WHERE assessment_id = p_assessment_id AND student_id = auth.uid();

  IF v_att IS NULL OR v_att NOT IN ('present', 'late') THEN
    RAISE EXCEPTION 'not_marked_present';
  END IF;

  SELECT * INTO v_paper
    FROM exam_papers
   WHERE assessment_id = p_assessment_id AND student_id = auth.uid();
  IF FOUND THEN
    RETURN v_paper;
  END IF;

  v_qps := coalesce((v_a.rules->>'questions_per_student')::int, 2);
  v_dur := coalesce((v_a.rules->>'duration_min')::int, 120);

  -- Pick questions balanced by CO when possible, using distinct CO first
  WITH picked_by_co AS (
    SELECT DISTINCT ON (q.co_code) q.id
      FROM assessment_questions aq
      JOIN questions q ON q.id = aq.question_id
     WHERE aq.assessment_id = p_assessment_id AND aq.approved = true
     ORDER BY q.co_code, random()
  ),
  first_pass AS (
    SELECT id FROM picked_by_co LIMIT v_qps
  ),
  fill_rest AS (
    SELECT aq.question_id AS id
      FROM assessment_questions aq
     WHERE aq.assessment_id = p_assessment_id
       AND aq.approved = true
       AND aq.question_id NOT IN (SELECT id FROM first_pass)
     ORDER BY random()
     LIMIT greatest(0, v_qps - (SELECT count(*)::int FROM first_pass))
  )
  SELECT array_agg(id) INTO v_q_ids
    FROM (SELECT id FROM first_pass UNION ALL SELECT id FROM fill_rest) u;

  IF v_q_ids IS NULL OR cardinality(v_q_ids) < v_qps THEN
    RAISE EXCEPTION 'insufficient_questions';
  END IF;

  -- Late students only receive remaining time from activated_at + duration
  v_deadline := least(
    now() + make_interval(mins => v_dur),
    v_a.activated_at + make_interval(mins => v_dur)
  );

  INSERT INTO exam_papers (institution_id, assessment_id, student_id, q_ids, started_at, deadline)
  VALUES (v_a.institution_id, p_assessment_id, auth.uid(), v_q_ids, now(), v_deadline)
  RETURNING * INTO v_paper;

  PERFORM public.audit(
    'start_exam',
    'exam_paper',
    v_paper.id::text,
    jsonb_build_object('assessment_id', p_assessment_id, 'q_ids', v_q_ids),
    v_a.institution_id
  );

  RETURN v_paper;
END;
$$;

-- ── grant_extra_time ─────────────────────────────────────────────────────

CREATE OR REPLACE FUNCTION grant_extra_time(p_paper_id uuid, p_minutes integer)
RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public
AS $$
DECLARE
  v_p exam_papers%ROWTYPE;
  v_a assessments%ROWTYPE;
BEGIN
  IF p_minutes IS NULL OR p_minutes <= 0 THEN RAISE EXCEPTION 'invalid_input'; END IF;
  SELECT * INTO v_p FROM exam_papers WHERE id = p_paper_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'not_found'; END IF;
  SELECT * INTO v_a FROM assessments WHERE id = v_p.assessment_id;
  IF NOT is_course_faculty(v_a.course_id) THEN RAISE EXCEPTION 'forbidden'; END IF;

  UPDATE exam_papers
     SET extra_minutes = extra_minutes + p_minutes,
         deadline = deadline + make_interval(mins => p_minutes)
   WHERE id = p_paper_id;

  PERFORM public.audit(
    'grant_extra_time',
    'exam_paper',
    p_paper_id::text,
    jsonb_build_object('minutes', p_minutes),
    v_a.institution_id
  );
END;
$$;

-- ── log_proctor_event ────────────────────────────────────────────────────

CREATE OR REPLACE FUNCTION log_proctor_event(
  p_paper_id uuid,
  p_type proctor_event_type,
  p_severity integer DEFAULT 1,
  p_detail text DEFAULT '',
  p_snapshot_path text DEFAULT NULL
)
RETURNS integer
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public
AS $$
DECLARE
  v_p exam_papers%ROWTYPE;
  v_cnt int;
BEGIN
  SELECT * INTO v_p FROM exam_papers WHERE id = p_paper_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'not_found'; END IF;
  IF v_p.student_id <> auth.uid() THEN RAISE EXCEPTION 'forbidden'; END IF;
  IF v_p.submitted_at IS NOT NULL THEN RAISE EXCEPTION 'already_submitted'; END IF;

  SELECT count(*)::int INTO v_cnt FROM proctor_events WHERE paper_id = p_paper_id;
  IF v_cnt >= 60 THEN
    RETURN v_cnt;
  END IF;

  INSERT INTO proctor_events (institution_id, paper_id, event_type, severity, detail, snapshot_path)
  VALUES (v_p.institution_id, p_paper_id, p_type, greatest(1, least(3, coalesce(p_severity, 1))), coalesce(p_detail, ''), p_snapshot_path);

  v_cnt := v_cnt + 1;
  IF v_cnt >= 3 THEN
    UPDATE exam_papers SET flagged = true WHERE id = p_paper_id;
  END IF;

  RETURN v_cnt;
END;
$$;

-- ── submit_exam ──────────────────────────────────────────────────────────

CREATE OR REPLACE FUNCTION submit_exam(p_paper_id uuid)
RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public
AS $$
DECLARE
  v_p exam_papers%ROWTYPE;
BEGIN
  SELECT * INTO v_p FROM exam_papers WHERE id = p_paper_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'not_found'; END IF;
  IF v_p.student_id <> auth.uid() THEN RAISE EXCEPTION 'forbidden'; END IF;

  UPDATE exam_papers
     SET submitted_at = coalesce(submitted_at, now())
   WHERE id = p_paper_id;

  PERFORM public.audit(
    'submit_exam',
    'exam_paper',
    p_paper_id::text,
    '{}'::jsonb,
    v_p.institution_id
  );
END;
$$;

-- ── end_assessment ───────────────────────────────────────────────────────

CREATE OR REPLACE FUNCTION end_assessment(p_assessment_id uuid)
RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public
AS $$
DECLARE
  v_a assessments%ROWTYPE;
BEGIN
  SELECT * INTO v_a FROM assessments WHERE id = p_assessment_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'not_found'; END IF;
  IF NOT is_course_faculty(v_a.course_id) THEN RAISE EXCEPTION 'forbidden'; END IF;
  IF v_a.stage <> 'live' THEN RAISE EXCEPTION 'not_live'; END IF;

  UPDATE exam_papers
     SET submitted_at = coalesce(submitted_at, now())
   WHERE assessment_id = p_assessment_id AND submitted_at IS NULL;

  UPDATE assessments
     SET stage = 'marks',
         ended_at = coalesce(ended_at, now())
   WHERE id = p_assessment_id;

  PERFORM public.audit(
    'end_assessment',
    'assessment',
    p_assessment_id::text,
    '{}'::jsonb,
    v_a.institution_id
  );
END;
$$;

-- ── review_proctor_event ─────────────────────────────────────────────────

CREATE OR REPLACE FUNCTION review_proctor_event(p_event_id uuid)
RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public
AS $$
DECLARE
  v_ev proctor_events%ROWTYPE;
  v_a assessments%ROWTYPE;
BEGIN
  SELECT * INTO v_ev FROM proctor_events WHERE id = p_event_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'not_found'; END IF;

  SELECT a.* INTO v_a
    FROM exam_papers ep
    JOIN assessments a ON a.id = ep.assessment_id
   WHERE ep.id = v_ev.paper_id;

  IF NOT is_course_faculty(v_a.course_id) THEN RAISE EXCEPTION 'forbidden'; END IF;

  UPDATE proctor_events
     SET reviewed_by = auth.uid(),
         reviewed_at = now()
   WHERE id = p_event_id;
END;
$$;

-- ── save_exam_viva ───────────────────────────────────────────────────────

CREATE OR REPLACE FUNCTION save_exam_viva(
  p_assessment_id uuid,
  p_student_id uuid,
  p_marks numeric
)
RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public
AS $$
DECLARE
  v_a assessments%ROWTYPE;
  v_max numeric;
BEGIN
  SELECT * INTO v_a FROM assessments WHERE id = p_assessment_id;
  IF NOT FOUND THEN RAISE EXCEPTION 'not_found'; END IF;
  IF NOT is_course_faculty(v_a.course_id) THEN RAISE EXCEPTION 'forbidden'; END IF;

  v_max := coalesce((v_a.rules->>'viva_marks')::numeric, 10);
  IF p_marks < 0 OR p_marks > v_max THEN
    RAISE EXCEPTION 'invalid_marks';
  END IF;

  INSERT INTO viva (institution_id, assessment_id, student_id, marks, examiner_id)
  VALUES (v_a.institution_id, p_assessment_id, p_student_id, p_marks, auth.uid())
  ON CONFLICT (assessment_id, student_id) WHERE assessment_id IS NOT NULL
  DO UPDATE SET marks = excluded.marks, examiner_id = auth.uid(), updated_at = now();
END;
$$;

-- ── add_assessment_to_file ───────────────────────────────────────────────

CREATE OR REPLACE FUNCTION add_assessment_to_file(p_assessment_id uuid)
RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public
AS $$
DECLARE
  v_a assessments%ROWTYPE;
  v_unreviewed int;
BEGIN
  SELECT * INTO v_a FROM assessments WHERE id = p_assessment_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'not_found'; END IF;
  IF NOT is_course_faculty(v_a.course_id) THEN RAISE EXCEPTION 'forbidden'; END IF;
  IF v_a.ended_at IS NULL THEN RAISE EXCEPTION 'not_ended'; END IF;

  SELECT count(*)::int INTO v_unreviewed
    FROM proctor_events pe
    JOIN exam_papers ep ON ep.id = pe.paper_id
   WHERE ep.assessment_id = p_assessment_id
     AND ep.flagged = true
     AND pe.reviewed_at IS NULL;

  IF v_unreviewed > 0 THEN
    RAISE EXCEPTION 'unreviewed_flags';
  END IF;

  UPDATE assessments
     SET added_to_file = true
   WHERE id = p_assessment_id;

  PERFORM public.audit(
    'add_assessment_to_file',
    'assessment',
    p_assessment_id::text,
    '{}'::jsonb,
    v_a.institution_id
  );
END;
$$;

-- ── authorize_run extension for exam context ─────────────────────────────

DROP FUNCTION IF EXISTS authorize_run(uuid, uuid, run_context, uuid);

CREATE OR REPLACE FUNCTION authorize_run(
  p_user_id uuid,
  p_question_id uuid,
  p_context run_context,
  p_mode run_mode DEFAULT 'run',
  p_paper_id uuid DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_q public.questions%ROWTYPE;
  v_course public.courses%ROWTYPE;
  v_sess public.sessions%ROWTYPE;
  v_batch_id uuid;
  v_run_id uuid;
  v_att_state text;
  v_paper public.exam_papers%ROWTYPE;
  v_assess public.assessments%ROWTYPE;
  v_vis jsonb;
  v_hid jsonb;
BEGIN
  SELECT * INTO v_q FROM public.questions WHERE id = p_question_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'not_found';
  END IF;

  SELECT * INTO v_course FROM public.courses WHERE id = v_q.course_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'not_found';
  END IF;

  IF p_context = 'lab' THEN
    IF v_q.kind <> 'lab' OR v_q.session_id IS NULL THEN
      RAISE EXCEPTION 'forbidden';
    END IF;
    IF v_course.faculty_id = p_user_id THEN
      NULL;
    ELSIF EXISTS (
      SELECT 1 FROM public.enrollments e
      WHERE e.course_id = v_q.course_id AND e.student_id = p_user_id
    ) THEN
      SELECT * INTO v_sess FROM public.sessions WHERE id = v_q.session_id;
      IF v_sess.status = 'none' THEN
        RAISE EXCEPTION 'session_not_open';
      END IF;
      IF to_regclass('public.session_runs') IS NOT NULL AND to_regclass('public.attendance') IS NOT NULL THEN
        SELECT e.batch_id INTO v_batch_id
        FROM public.enrollments e
        WHERE e.course_id = v_q.course_id AND e.student_id = p_user_id
        LIMIT 1;

        EXECUTE
          'SELECT sr.id, a.state::text
           FROM public.session_runs sr
           JOIN public.attendance a ON a.session_run_id = sr.id AND a.student_id = $1
           WHERE sr.session_id = $2
             AND sr.batch_id = $3
             AND sr.started_at IS NOT NULL
             AND sr.ended_at IS NULL
           LIMIT 1'
        INTO v_run_id, v_att_state
        USING p_user_id, v_sess.id, v_batch_id;

        IF v_run_id IS NULL OR v_att_state NOT IN ('present', 'late') THEN
          RAISE EXCEPTION 'session_not_open';
        END IF;
      END IF;
    ELSE
      RAISE EXCEPTION 'forbidden';
    END IF;
  ELSIF p_context = 'exam' THEN
    IF p_paper_id IS NULL THEN
      RAISE EXCEPTION 'forbidden';
    END IF;
    SELECT * INTO v_paper FROM public.exam_papers WHERE id = p_paper_id;
    IF NOT FOUND OR v_paper.student_id <> p_user_id THEN
      RAISE EXCEPTION 'forbidden';
    END IF;
    IF v_paper.submitted_at IS NOT NULL OR now() > v_paper.deadline THEN
      RAISE EXCEPTION 'exam_closed';
    END IF;
    IF NOT (p_question_id = ANY(v_paper.q_ids)) THEN
      RAISE EXCEPTION 'forbidden';
    END IF;
    SELECT * INTO v_assess FROM public.assessments WHERE id = v_paper.assessment_id;
    IF NOT FOUND OR v_assess.stage <> 'live' OR v_assess.ended_at IS NOT NULL THEN
      RAISE EXCEPTION 'exam_closed';
    END IF;
  ELSE
    RAISE EXCEPTION 'invalid_input';
  END IF;

  SELECT coalesce(
    jsonb_agg(
      jsonb_build_object('ord', ord, 'input', input, 'expected', expected, 'marks', marks)
      ORDER BY ord
    ),
    '[]'::jsonb
  )
  INTO v_vis
  FROM public.test_cases
  WHERE question_id = p_question_id AND hidden = false;

  SELECT coalesce(
    jsonb_agg(
      jsonb_build_object('ord', ord, 'input', input, 'expected', expected, 'marks', marks)
      ORDER BY ord
    ),
    '[]'::jsonb
  )
  INTO v_hid
  FROM public.test_cases
  WHERE question_id = p_question_id AND hidden = true;

  RETURN jsonb_build_object(
    'institution_id', v_course.institution_id,
    'course_id', v_course.id,
    'session_id', v_q.session_id,
    'allowed_langs', v_course.allowed_langs,
    'visible_tests', v_vis,
    'hidden_tests', v_hid
  );
END;
$$;

REVOKE ALL ON FUNCTION authorize_run(uuid, uuid, run_context, run_mode, uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION authorize_run(uuid, uuid, run_context, run_mode, uuid) TO service_role;

GRANT EXECUTE ON FUNCTION create_assessment(uuid, uuid, jsonb, uuid[]) TO authenticated;
GRANT EXECUTE ON FUNCTION pick_assessment_questions(uuid, uuid[]) TO authenticated;
GRANT EXECUTE ON FUNCTION send_assessment_to_hod(uuid) TO authenticated;
GRANT EXECUTE ON FUNCTION decide_assessment(uuid, boolean, text) TO authenticated;
GRANT EXECUTE ON FUNCTION schedule_assessment(uuid, timestamptz, text) TO authenticated;
GRANT EXECUTE ON FUNCTION save_exam_attendance(uuid, jsonb) TO authenticated;
GRANT EXECUTE ON FUNCTION activate_assessment(uuid) TO authenticated;
GRANT EXECUTE ON FUNCTION start_exam(uuid) TO authenticated;
GRANT EXECUTE ON FUNCTION grant_extra_time(uuid, integer) TO authenticated;
GRANT EXECUTE ON FUNCTION log_proctor_event(uuid, proctor_event_type, integer, text, text) TO authenticated;
GRANT EXECUTE ON FUNCTION submit_exam(uuid) TO authenticated;
GRANT EXECUTE ON FUNCTION end_assessment(uuid) TO authenticated;
GRANT EXECUTE ON FUNCTION review_proctor_event(uuid) TO authenticated;
GRANT EXECUTE ON FUNCTION save_exam_viva(uuid, uuid, numeric) TO authenticated;
GRANT EXECUTE ON FUNCTION add_assessment_to_file(uuid) TO authenticated;
