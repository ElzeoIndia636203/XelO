-- Pick 1 question per slot (shuffled) for instant test attempts and filter student_get_instant_attempt by assigned_question_ids.

CREATE OR REPLACE FUNCTION pick_instant_question_ids(
  p_questions jsonb,
  p_question_count integer
)
RETURNS text[]
LANGUAGE plpgsql
VOLATILE
SET search_path = public
AS $$
DECLARE
  v_has_slots boolean;
  v_slot integer;
  v_qid text;
  v_picked text[] := '{}'::text[];
BEGIN
  SELECT EXISTS (
    SELECT 1 FROM jsonb_array_elements(COALESCE(p_questions, '[]'::jsonb)) AS elem
    WHERE elem ? 'slot'
  ) INTO v_has_slots;

  IF v_has_slots THEN
    FOR v_slot IN 1..greatest(1, COALESCE(p_question_count, 1)) LOOP
      SELECT elem->>'id' INTO v_qid
      FROM jsonb_array_elements(COALESCE(p_questions, '[]'::jsonb)) AS elem
      WHERE (elem->>'slot')::integer = v_slot
      ORDER BY random()
      LIMIT 1;
      IF v_qid IS NOT NULL THEN
        v_picked := array_append(v_picked, v_qid);
      END IF;
    END LOOP;
    SELECT ARRAY(SELECT qid FROM unnest(v_picked) AS qid ORDER BY random()) INTO v_picked;
  ELSE
    SELECT ARRAY(
      SELECT elem->>'id'
      FROM jsonb_array_elements(COALESCE(p_questions, '[]'::jsonb)) AS elem
      ORDER BY random()
      LIMIT greatest(1, COALESCE(p_question_count, 1))
    ) INTO v_picked;
  END IF;

  RETURN COALESCE(v_picked, '{}'::text[]);
END;
$$;

CREATE OR REPLACE FUNCTION student_start_course_instant_test(p_test_id uuid)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_me public.profiles%ROWTYPE;
  v_t public.instant_tests%ROWTYPE;
  v_pt public.instant_test_participants%ROWTYPE;
  v_attempt public.instant_test_attempts%ROWTYPE;
  v_prn text;
  v_name text;
  v_picked text[];
BEGIN
  SELECT * INTO v_me FROM public.profiles WHERE id = auth.uid() AND active = true;
  IF NOT FOUND OR v_me.role <> 'student' THEN
    RAISE EXCEPTION 'forbidden';
  END IF;

  SELECT * INTO v_t FROM public.instant_tests WHERE id = p_test_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'not_found';
  END IF;

  IF v_t.status <> 'active' OR v_t.active <> true THEN
    RAISE EXCEPTION 'test_not_active';
  END IF;

  SELECT * INTO v_pt
  FROM public.instant_test_participants
  WHERE test_id = v_t.id AND student_id = v_me.id;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'forbidden';
  END IF;

  IF v_pt.approval_status = 'pending' THEN
    RAISE EXCEPTION 'pending_faculty_approval';
  END IF;

  IF v_pt.approval_status = 'rejected' THEN
    RAISE EXCEPTION 'join_request_rejected';
  END IF;

  IF v_pt.attendance_status = 'absent' THEN
    RAISE EXCEPTION 'marked_absent';
  END IF;

  v_prn := coalesce(NULLIF(trim(coalesce(v_pt.requested_prn, '')), ''), NULLIF(trim(coalesce(v_me.roll_no, '')), ''), v_me.email);
  v_name := coalesce(NULLIF(trim(coalesce(v_pt.requested_name, '')), ''), NULLIF(trim(coalesce(v_me.full_name, '')), ''), v_me.email);
  v_picked := public.pick_instant_question_ids(v_t.questions, v_t.question_count);

  INSERT INTO public.instant_test_attempts (
    test_id, institution_id, student_id, prn, student_name, assigned_question_ids
  ) VALUES (
    v_t.id, v_t.institution_id, v_me.id, v_prn, v_name, v_picked
  )
  ON CONFLICT (test_id, student_id) DO UPDATE
    SET assigned_question_ids = CASE
      WHEN coalesce(array_length(public.instant_test_attempts.assigned_question_ids, 1), 0) > 0
      THEN public.instant_test_attempts.assigned_question_ids
      ELSE EXCLUDED.assigned_question_ids
    END
  RETURNING * INTO v_attempt;

  RETURN jsonb_build_object(
    'attempt_id', v_attempt.id,
    'test_id', v_t.id
  );
END;
$$;

CREATE OR REPLACE FUNCTION student_get_instant_attempt(p_attempt_id uuid)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_attempt public.instant_test_attempts%ROWTYPE;
  v_t public.instant_tests%ROWTYPE;
  v_sanitized_qs jsonb := '[]'::jsonb;
  v_sanitized_pre jsonb := '[]'::jsonb;
  v_q jsonb;
  v_pq jsonb;
  v_assigned text[];
  v_qid text;
BEGIN
  SELECT * INTO v_attempt FROM public.instant_test_attempts WHERE id = p_attempt_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'not_found';
  END IF;
  IF v_attempt.student_id <> auth.uid() THEN
    RAISE EXCEPTION 'forbidden';
  END IF;

  SELECT * INTO v_t FROM public.instant_tests WHERE id = v_attempt.test_id;

  v_assigned := v_attempt.assigned_question_ids;
  IF coalesce(array_length(v_assigned, 1), 0) = 0 THEN
    v_assigned := public.pick_instant_question_ids(v_t.questions, v_t.question_count);
    UPDATE public.instant_test_attempts
    SET assigned_question_ids = v_assigned
    WHERE id = v_attempt.id;
  END IF;

  FOREACH v_qid IN ARRAY v_assigned LOOP
    SELECT value INTO v_q
    FROM jsonb_array_elements(v_t.questions)
    WHERE value->>'id' = v_qid
    LIMIT 1;
    IF v_q IS NOT NULL THEN
      v_sanitized_qs := v_sanitized_qs || jsonb_build_array(
        jsonb_build_object(
          'id', v_q->>'id',
          'title', v_q->>'title',
          'statement', v_q->>'statement',
          'input_spec', coalesce(v_q->>'input_spec', ''),
          'output_spec', coalesce(v_q->>'output_spec', ''),
          'constraints', coalesce(v_q->>'constraints', ''),
          'sample_input', coalesce(v_q->>'sample_input', ''),
          'sample_output', coalesce(v_q->>'sample_output', ''),
          'difficulty', coalesce(v_q->>'difficulty', v_t.difficulty),
          'marks', coalesce((v_q->>'marks')::numeric, 0),
          'co_code', coalesce(v_q->>'co_code', v_t.co_code),
          'visible_tests', coalesce(v_q->'visible_tests', '[]'::jsonb),
          'hidden_count', jsonb_array_length(coalesce(v_q->'hidden_tests', '[]'::jsonb))
        )
      );
    END IF;
  END LOOP;

  FOR v_pq IN SELECT value FROM jsonb_array_elements(COALESCE(v_t.pretest_questions, '[]'::jsonb))
  LOOP
    v_sanitized_pre := v_sanitized_pre || jsonb_build_array(
      jsonb_build_object(
        'id', v_pq->>'id',
        'stem', v_pq->>'stem',
        'options', coalesce(v_pq->'options', '[]'::jsonb)
      )
    );
  END LOOP;

  RETURN jsonb_build_object(
    'attempt_id', v_attempt.id,
    'test_id', v_t.id,
    'test_code', v_t.test_code,
    'topic', v_t.topic,
    'total_marks', v_t.total_marks,
    'status', v_t.status,
    'allowed_langs', v_t.allowed_langs,
    'prn', v_attempt.prn,
    'student_name', v_attempt.student_name,
    'submitted_at', v_attempt.submitted_at,
    'total_score', v_attempt.total_score,
    'pretest_count', v_t.pretest_count,
    'pretest_marks', v_t.pretest_marks,
    'pretest_score', v_attempt.pretest_score,
    'pretest_answers', v_attempt.pretest_answers,
    'pretest_questions', v_sanitized_pre,
    'coding_score', v_attempt.coding_score,
    'coding_override_score', v_attempt.coding_override_score,
    'viva_marks', v_t.viva_marks,
    'viva_score', v_attempt.viva_score,
    'final_score', v_attempt.final_score,
    'answers', v_attempt.answers,
    'questions', v_sanitized_qs
  );
END;
$$;
