-- Phase 4: Workflows for lab runs, attendance, check-ins, tests, drafts, viva, hints, and flags

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
  v_id uuid;
BEGIN
  IF v_inst IS NULL THEN
    SELECT institution_id INTO v_inst FROM public.profiles WHERE id = p_user_id;
  END IF;
  IF v_inst IS NULL THEN
    RAISE EXCEPTION 'not_found';
  END IF;

  INSERT INTO public.notifications (institution_id, user_id, kind, title, body, link)
  VALUES (v_inst, p_user_id, p_kind, trim(p_title), coalesce(p_body, ''), coalesce(p_link, ''))
  RETURNING id INTO v_id;

  RETURN v_id;
END;
$$;

REVOKE ALL ON FUNCTION public.notify(uuid, text, text, text, text, uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.notify(uuid, text, text, text, text, uuid) TO service_role;

CREATE OR REPLACE FUNCTION start_session_run(
  p_session_id uuid,
  p_batch_id uuid
)
RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_sess public.sessions%ROWTYPE;
  v_batch public.batches%ROWTYPE;
  v_run_id uuid;
BEGIN
  SELECT * INTO v_sess FROM public.sessions WHERE id = p_session_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'not_found';
  END IF;

  IF NOT is_course_faculty(v_sess.course_id) THEN
    RAISE EXCEPTION 'forbidden';
  END IF;

  IF v_sess.status NOT IN ('active', 'conducted') THEN
    RAISE EXCEPTION 'not_editable';
  END IF;

  SELECT * INTO v_batch FROM public.batches WHERE id = p_batch_id AND course_id = v_sess.course_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'invalid_input';
  END IF;

  SELECT id INTO v_run_id
  FROM public.session_runs
  WHERE session_id = p_session_id AND batch_id = p_batch_id;

  IF v_run_id IS NOT NULL THEN
    RETURN v_run_id;
  END IF;

  INSERT INTO public.session_runs (institution_id, session_id, batch_id, attendance_done)
  VALUES (v_sess.institution_id, p_session_id, p_batch_id, false)
  ON CONFLICT (session_id, batch_id) DO NOTHING
  RETURNING id INTO v_run_id;

  IF v_run_id IS NULL THEN
    SELECT id INTO v_run_id
    FROM public.session_runs
    WHERE session_id = p_session_id AND batch_id = p_batch_id;
  END IF;

  RETURN v_run_id;
END;
$$;

CREATE OR REPLACE FUNCTION lab_checkin(p_session_id uuid)
RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_uid uuid := auth.uid();
  v_sess public.sessions%ROWTYPE;
  v_id uuid;
BEGIN
  SELECT * INTO v_sess FROM public.sessions WHERE id = p_session_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'not_found';
  END IF;

  IF NOT is_course_student(v_sess.course_id) THEN
    RAISE EXCEPTION 'forbidden';
  END IF;

  IF v_sess.status NOT IN ('active', 'conducted') THEN
    RAISE EXCEPTION 'session_not_open';
  END IF;

  INSERT INTO public.lab_checkins (institution_id, session_id, student_id, first_at, last_at)
  VALUES (v_sess.institution_id, p_session_id, v_uid, now(), now())
  ON CONFLICT (session_id, student_id)
  DO UPDATE SET last_at = now()
  RETURNING id INTO v_id;

  RETURN v_id;
END;
$$;

CREATE OR REPLACE FUNCTION suggest_attendance(p_run_id uuid)
RETURNS TABLE (
  student_id uuid,
  full_name text,
  roll_no text,
  email text,
  suggested_state attendance_state
)
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_run public.session_runs%ROWTYPE;
  v_course_id uuid;
BEGIN
  SELECT * INTO v_run FROM public.session_runs WHERE id = p_run_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'not_found';
  END IF;

  SELECT course_id INTO v_course_id FROM public.sessions WHERE id = v_run.session_id;
  IF NOT is_course_faculty(v_course_id) THEN
    RAISE EXCEPTION 'forbidden';
  END IF;

  RETURN QUERY
  SELECT
    p.id,
    p.full_name,
    coalesce(p.roll_no, ''),
    p.email,
    CASE
      WHEN lc.last_at IS NOT NULL AND lc.last_at >= now() - interval '3 hours'
        THEN 'present'::attendance_state
      ELSE 'absent'::attendance_state
    END
  FROM public.enrollments e
  JOIN public.profiles p ON p.id = e.student_id
  LEFT JOIN public.lab_checkins lc
    ON lc.session_id = v_run.session_id AND lc.student_id = e.student_id
  WHERE e.batch_id = v_run.batch_id AND p.active = true
  ORDER BY p.roll_no NULLS LAST, p.full_name;
END;
$$;

CREATE OR REPLACE FUNCTION save_attendance(
  p_run_id uuid,
  p_entries jsonb
)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_run public.session_runs%ROWTYPE;
  v_sess public.sessions%ROWTYPE;
  v_entry jsonb;
  v_sid uuid;
  v_state text;
  v_now timestamptz := now();
  v_eod_ist timestamptz := ((v_now AT TIME ZONE 'Asia/Kolkata')::date::timestamp + time '23:59') AT TIME ZONE 'Asia/Kolkata';
BEGIN
  SELECT * INTO v_run FROM public.session_runs WHERE id = p_run_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'not_found';
  END IF;

  SELECT * INTO v_sess FROM public.sessions WHERE id = v_run.session_id;
  IF NOT is_course_faculty(v_sess.course_id) THEN
    RAISE EXCEPTION 'forbidden';
  END IF;

  IF jsonb_typeof(p_entries) <> 'array' OR jsonb_array_length(p_entries) = 0 THEN
    RAISE EXCEPTION 'invalid_input';
  END IF;

  FOR v_entry IN SELECT value FROM jsonb_array_elements(p_entries)
  LOOP
    BEGIN
      v_sid := (v_entry->>'student_id')::uuid;
    EXCEPTION WHEN OTHERS THEN
      RAISE EXCEPTION 'invalid_input';
    END;
    v_state := lower(trim(coalesce(v_entry->>'state', '')));
    IF v_state NOT IN ('present', 'late', 'absent') THEN
      RAISE EXCEPTION 'invalid_input';
    END IF;

    IF NOT EXISTS (
      SELECT 1 FROM public.enrollments e
      WHERE e.batch_id = v_run.batch_id AND e.student_id = v_sid
    ) THEN
      RAISE EXCEPTION 'forbidden';
    END IF;

    INSERT INTO public.attendance (
      institution_id, session_run_id, student_id, state, marked_by, at
    )
    VALUES (
      v_run.institution_id, p_run_id, v_sid, v_state::attendance_state, auth.uid(), v_now
    )
    ON CONFLICT (session_run_id, student_id) WHERE session_run_id IS NOT NULL
    DO UPDATE SET state = EXCLUDED.state, marked_by = auth.uid(), at = v_now;
  END LOOP;

  UPDATE public.session_runs
  SET
    attendance_done = true,
    started_at = coalesce(started_at, v_now),
    post_close = coalesce(post_close, v_eod_ist)
  WHERE id = p_run_id;

  UPDATE public.sessions
  SET
    status = 'conducted',
    pre_close = least(coalesce(pre_close, v_now), v_now),
    post_close = v_eod_ist
  WHERE id = v_sess.id;

  PERFORM public.audit(
    'save_attendance',
    'session_run',
    p_run_id::text,
    jsonb_build_object('count', jsonb_array_length(p_entries)),
    v_run.institution_id
  );
END;
$$;

CREATE OR REPLACE FUNCTION end_session_run(
  p_run_id uuid,
  p_remark text DEFAULT ''
)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_run public.session_runs%ROWTYPE;
  v_course_id uuid;
BEGIN
  SELECT * INTO v_run FROM public.session_runs WHERE id = p_run_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'not_found';
  END IF;

  SELECT course_id INTO v_course_id FROM public.sessions WHERE id = v_run.session_id;
  IF NOT is_course_faculty(v_course_id) THEN
    RAISE EXCEPTION 'forbidden';
  END IF;

  UPDATE public.session_runs
  SET ended_at = now(), remark = trim(coalesce(p_remark, ''))
  WHERE id = p_run_id;

  PERFORM public.audit(
    'end_session_run',
    'session_run',
    p_run_id::text,
    jsonb_build_object('remark', trim(coalesce(p_remark, ''))),
    v_run.institution_id
  );
END;
$$;

CREATE OR REPLACE FUNCTION start_test(
  p_session_id uuid,
  p_bank bank_type
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_uid uuid := auth.uid();
  v_sess public.sessions%ROWTYPE;
  v_batch_id uuid;
  v_run public.session_runs%ROWTYPE;
  v_existing public.test_attempts%ROWTYPE;
  v_req_qs integer := 0;
  v_passed_qs integer := 0;
  v_post_deadline timestamptz;
  v_item_ids uuid[];
  v_items jsonb;
  v_attempt_id uuid;
  v_started timestamptz;
BEGIN
  SELECT * INTO v_sess FROM public.sessions WHERE id = p_session_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'not_found';
  END IF;

  IF NOT is_course_student(v_sess.course_id) THEN
    RAISE EXCEPTION 'forbidden';
  END IF;

  IF v_sess.status NOT IN ('active', 'conducted') THEN
    RAISE EXCEPTION 'session_not_open';
  END IF;

  SELECT e.batch_id INTO v_batch_id
  FROM public.enrollments e
  WHERE e.course_id = v_sess.course_id AND e.student_id = v_uid;

  SELECT * INTO v_run
  FROM public.session_runs
  WHERE session_id = p_session_id AND batch_id = v_batch_id;

  IF p_bank = 'pre' AND v_run.id IS NOT NULL AND v_run.attendance_done IS TRUE THEN
    RAISE EXCEPTION 'test_closed';
  END IF;

  SELECT * INTO v_existing
  FROM public.test_attempts
  WHERE session_id = p_session_id AND student_id = v_uid AND bank = p_bank;

  IF FOUND THEN
    IF v_existing.submitted_at IS NOT NULL THEN
      RAISE EXCEPTION 'already_submitted';
    END IF;

    SELECT coalesce(
      jsonb_agg(
        jsonb_build_object('id', bi.id, 'level', bi.level::text, 'stem', bi.stem, 'options', bi.options)
        ORDER BY array_position(v_existing.item_ids, bi.id)
      ),
      '[]'::jsonb
    )
    INTO v_items
    FROM public.bank_items bi
    WHERE bi.id = ANY(v_existing.item_ids);

    RETURN jsonb_build_object(
      'attempt_id', v_existing.id,
      'bank', p_bank::text,
      'started_at', v_existing.started_at,
      'items', v_items
    );
  END IF;

  IF p_bank = 'post' THEN
    SELECT count(*)::integer INTO v_req_qs
    FROM public.session_questions
    WHERE session_id = p_session_id;

    SELECT count(DISTINCT sq.question_id)::integer INTO v_passed_qs
    FROM public.session_questions sq
    JOIN public.submissions sub
      ON sub.question_id = sq.question_id
     AND sub.student_id = v_uid
     AND sub.mode = 'submit'
     AND sub.hidden_total > 0
     AND sub.hidden_passed = sub.hidden_total
    WHERE sq.session_id = p_session_id;

    IF v_req_qs < 2 OR v_passed_qs < v_req_qs THEN
      RAISE EXCEPTION 'post_test_locked';
    END IF;

    v_post_deadline := coalesce(
      v_run.post_close,
      v_sess.post_close,
      (((now() AT TIME ZONE 'Asia/Kolkata')::date::timestamp + time '23:59') AT TIME ZONE 'Asia/Kolkata')
    );
    IF now() > v_post_deadline THEN
      RAISE EXCEPTION 'test_closed';
    END IF;

    WITH picked AS (
      (SELECT id FROM public.bank_items WHERE session_id = p_session_id AND bank = 'post' AND level = 'easy' AND approved ORDER BY random() LIMIT 1)
      UNION ALL
      (SELECT id FROM public.bank_items WHERE session_id = p_session_id AND bank = 'post' AND level = 'medium' AND approved ORDER BY random() LIMIT 2)
      UNION ALL
      (SELECT id FROM public.bank_items WHERE session_id = p_session_id AND bank = 'post' AND level = 'hard' AND approved ORDER BY random() LIMIT 2)
    )
    SELECT array_agg(id) INTO v_item_ids FROM picked;
  ELSE
    WITH picked AS (
      (SELECT id FROM public.bank_items WHERE session_id = p_session_id AND bank = 'pre' AND level = 'easy' AND approved ORDER BY random() LIMIT 2)
      UNION ALL
      (SELECT id FROM public.bank_items WHERE session_id = p_session_id AND bank = 'pre' AND level = 'medium' AND approved ORDER BY random() LIMIT 2)
      UNION ALL
      (SELECT id FROM public.bank_items WHERE session_id = p_session_id AND bank = 'pre' AND level = 'hard' AND approved ORDER BY random() LIMIT 1)
    )
    SELECT array_agg(id) INTO v_item_ids FROM picked;
  END IF;

  IF coalesce(array_length(v_item_ids, 1), 0) <> 5 THEN
    RAISE EXCEPTION 'bank_incomplete';
  END IF;

  INSERT INTO public.test_attempts (institution_id, session_id, student_id, bank, item_ids)
  VALUES (v_sess.institution_id, p_session_id, v_uid, p_bank, v_item_ids)
  RETURNING id, started_at INTO v_attempt_id, v_started;

  -- Intentionally exclude answer column
  SELECT coalesce(
    jsonb_agg(
      jsonb_build_object('id', bi.id, 'level', bi.level::text, 'stem', bi.stem, 'options', bi.options)
      ORDER BY array_position(v_item_ids, bi.id)
    ),
    '[]'::jsonb
  )
  INTO v_items
  FROM public.bank_items bi
  WHERE bi.id = ANY(v_item_ids);

  RETURN jsonb_build_object(
    'attempt_id', v_attempt_id,
    'bank', p_bank::text,
    'started_at', v_started,
    'items', v_items
  );
END;
$$;

CREATE OR REPLACE FUNCTION submit_test(
  p_attempt_id uuid,
  p_answers jsonb
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_att public.test_attempts%ROWTYPE;
  v_sess public.sessions%ROWTYPE;
  v_batch_id uuid;
  v_run public.session_runs%ROWTYPE;
  v_post_deadline timestamptz;
  v_score integer := 0;
  v_total integer;
BEGIN
  SELECT * INTO v_att FROM public.test_attempts WHERE id = p_attempt_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'not_found';
  END IF;

  IF v_att.student_id <> auth.uid() THEN
    RAISE EXCEPTION 'forbidden';
  END IF;

  IF v_att.submitted_at IS NOT NULL THEN
    RAISE EXCEPTION 'already_submitted';
  END IF;

  SELECT * INTO v_sess FROM public.sessions WHERE id = v_att.session_id;
  SELECT e.batch_id INTO v_batch_id
  FROM public.enrollments e
  WHERE e.course_id = v_sess.course_id AND e.student_id = v_att.student_id;

  SELECT * INTO v_run
  FROM public.session_runs
  WHERE session_id = v_att.session_id AND batch_id = v_batch_id;

  IF v_att.bank = 'pre' AND v_run.id IS NOT NULL AND v_run.attendance_done IS TRUE THEN
    RAISE EXCEPTION 'test_closed';
  END IF;

  IF v_att.bank = 'post' THEN
    v_post_deadline := coalesce(
      v_run.post_close,
      v_sess.post_close,
      (((now() AT TIME ZONE 'Asia/Kolkata')::date::timestamp + time '23:59') AT TIME ZONE 'Asia/Kolkata')
    );
    IF now() > v_post_deadline THEN
      RAISE EXCEPTION 'test_closed';
    END IF;
  END IF;

  SELECT count(*)::integer INTO v_score
  FROM public.bank_items bi
  WHERE bi.id = ANY(v_att.item_ids)
    AND jsonb_typeof(coalesce(p_answers, '{}'::jsonb)) = 'object'
    AND (p_answers ->> bi.id::text) ~ '^\d+$'
    AND (p_answers ->> bi.id::text)::integer = bi.answer;

  v_total := coalesce(array_length(v_att.item_ids, 1), 5);

  UPDATE public.test_attempts
  SET answers = coalesce(p_answers, '{}'::jsonb), score = v_score, submitted_at = now()
  WHERE id = p_attempt_id;

  PERFORM public.audit(
    'submit_test',
    'test_attempt',
    p_attempt_id::text,
    jsonb_build_object('bank', v_att.bank::text, 'score', v_score, 'total', v_total),
    v_att.institution_id
  );

  RETURN jsonb_build_object('score', v_score, 'total', v_total);
END;
$$;

CREATE OR REPLACE FUNCTION save_draft(
  p_question_id uuid,
  p_context run_context,
  p_lang text,
  p_code text
)
RETURNS timestamptz
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_uid uuid := auth.uid();
  v_q public.questions%ROWTYPE;
  v_updated timestamptz;
BEGIN
  SELECT * INTO v_q FROM public.questions WHERE id = p_question_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'not_found';
  END IF;

  IF NOT (is_course_student(v_q.course_id) OR is_course_faculty(v_q.course_id)) THEN
    RAISE EXCEPTION 'forbidden';
  END IF;

  IF p_lang NOT IN ('c', 'cpp', 'java', 'python', 'rust', 'go') OR char_length(coalesce(p_code, '')) > 50000 THEN
    RAISE EXCEPTION 'invalid_input';
  END IF;

  INSERT INTO public.drafts (institution_id, student_id, question_id, context, lang, code, updated_at)
  VALUES (v_q.institution_id, v_uid, p_question_id, p_context, p_lang, coalesce(p_code, ''), now())
  ON CONFLICT (student_id, question_id, context, lang)
  DO UPDATE SET code = EXCLUDED.code, updated_at = now()
  RETURNING updated_at INTO v_updated;

  RETURN v_updated;
END;
$$;

CREATE OR REPLACE FUNCTION set_viva(
  p_student_id uuid,
  p_session_id uuid,
  p_assessment_id uuid,
  p_marks numeric
)
RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_sess public.sessions%ROWTYPE;
  v_course public.courses%ROWTYPE;
  v_max_viva numeric := 10;
  v_att_state attendance_state;
  v_id uuid;
BEGIN
  IF p_session_id IS NOT NULL THEN
    SELECT * INTO v_sess FROM public.sessions WHERE id = p_session_id;
    IF NOT FOUND THEN
      RAISE EXCEPTION 'not_found';
    END IF;

    IF NOT is_course_faculty(v_sess.course_id) THEN
      RAISE EXCEPTION 'forbidden';
    END IF;

    SELECT * INTO v_course FROM public.courses WHERE id = v_sess.course_id;
    v_max_viva := coalesce((v_course.rubric->>'viva')::numeric, 10);

    IF p_marks < 0 OR p_marks > v_max_viva THEN
      RAISE EXCEPTION 'viva_exceeds_rubric';
    END IF;

    SELECT a.state INTO v_att_state
    FROM public.attendance a
    JOIN public.session_runs sr ON sr.id = a.session_run_id
    WHERE sr.session_id = p_session_id AND a.student_id = p_student_id
    ORDER BY a.at DESC
    LIMIT 1;

    IF v_att_state IS NULL OR v_att_state = 'absent' THEN
      RAISE EXCEPTION 'student_absent';
    END IF;

    INSERT INTO public.viva (institution_id, session_id, student_id, marks, examiner_id, updated_at)
    VALUES (v_course.institution_id, p_session_id, p_student_id, p_marks, auth.uid(), now())
    ON CONFLICT (session_id, student_id) WHERE session_id IS NOT NULL
    DO UPDATE SET marks = EXCLUDED.marks, examiner_id = auth.uid(), updated_at = now()
    RETURNING id INTO v_id;

    PERFORM public.audit(
      'set_viva',
      'viva',
      v_id::text,
      jsonb_build_object('session_id', p_session_id, 'student_id', p_student_id, 'marks', p_marks),
      v_course.institution_id
    );

    RETURN v_id;
  END IF;

  RAISE EXCEPTION 'invalid_input';
END;
$$;

CREATE OR REPLACE FUNCTION send_hint(
  p_run_id uuid,
  p_student_ids uuid[],
  p_text text
)
RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_run public.session_runs%ROWTYPE;
  v_course_id uuid;
  v_clean text := trim(coalesce(p_text, ''));
  v_sid uuid;
  v_count integer := 0;
BEGIN
  SELECT * INTO v_run FROM public.session_runs WHERE id = p_run_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'not_found';
  END IF;

  SELECT course_id INTO v_course_id FROM public.sessions WHERE id = v_run.session_id;
  IF NOT is_course_faculty(v_course_id) THEN
    RAISE EXCEPTION 'forbidden';
  END IF;

  IF v_clean = '' OR coalesce(array_length(p_student_ids, 1), 0) = 0 THEN
    RAISE EXCEPTION 'invalid_input';
  END IF;

  FOREACH v_sid IN ARRAY p_student_ids
  LOOP
    IF NOT EXISTS (
      SELECT 1 FROM public.enrollments e
      WHERE e.batch_id = v_run.batch_id AND e.student_id = v_sid
    ) THEN
      RAISE EXCEPTION 'forbidden';
    END IF;

    PERFORM public.notify(
      v_sid,
      'hint',
      'Hint from faculty',
      v_clean,
      '/student/lab/' || v_run.session_id::text,
      v_run.institution_id
    );
    v_count := v_count + 1;
  END LOOP;

  PERFORM public.audit(
    'send_hint',
    'session_run',
    p_run_id::text,
    jsonb_build_object('count', v_count),
    v_run.institution_id
  );

  RETURN v_count;
END;
$$;

CREATE OR REPLACE FUNCTION flag_student(
  p_course_id uuid,
  p_student_id uuid,
  p_kind text,
  p_note text DEFAULT ''
)
RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_course public.courses%ROWTYPE;
  v_id uuid;
BEGIN
  IF NOT is_course_faculty(p_course_id) THEN
    RAISE EXCEPTION 'forbidden';
  END IF;

  IF p_kind NOT IN ('slow', 'fast') THEN
    RAISE EXCEPTION 'invalid_input';
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM public.enrollments e
    WHERE e.course_id = p_course_id AND e.student_id = p_student_id
  ) THEN
    RAISE EXCEPTION 'invalid_input';
  END IF;

  SELECT * INTO v_course FROM public.courses WHERE id = p_course_id;

  INSERT INTO public.course_flags (institution_id, course_id, student_id, kind, note, created_by)
  VALUES (v_course.institution_id, p_course_id, p_student_id, p_kind, trim(coalesce(p_note, '')), auth.uid())
  ON CONFLICT (course_id, student_id, kind)
  DO UPDATE SET note = EXCLUDED.note
  RETURNING id INTO v_id;

  PERFORM public.audit(
    'flag_student',
    'course_flag',
    v_id::text,
    jsonb_build_object('student_id', p_student_id, 'kind', p_kind),
    v_course.institution_id
  );

  RETURN v_id;
END;
$$;

GRANT EXECUTE ON FUNCTION
  start_session_run(uuid, uuid),
  lab_checkin(uuid),
  suggest_attendance(uuid),
  save_attendance(uuid, jsonb),
  end_session_run(uuid, text),
  start_test(uuid, bank_type),
  submit_test(uuid, jsonb),
  save_draft(uuid, run_context, text, text),
  set_viva(uuid, uuid, uuid, numeric),
  send_hint(uuid, uuid[], text),
  flag_student(uuid, uuid, text, text)
TO authenticated;
