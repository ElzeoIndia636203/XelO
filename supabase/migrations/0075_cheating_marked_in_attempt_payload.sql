-- Expose cheating_marked and ended_reason in student_get_instant_attempt so the
-- student page can show the terminated screen even after a refresh.
CREATE OR REPLACE FUNCTION student_get_instant_attempt(p_attempt_id uuid)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_attempt public.instant_test_attempts%ROWTYPE;
  v_t public.instant_tests%ROWTYPE;
  v_att_status text;
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

  SELECT attendance_status INTO v_att_status
  FROM public.instant_test_participants
  WHERE test_id = v_attempt.test_id
    AND student_id = v_attempt.student_id
  LIMIT 1;

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
    'attendance_status', v_att_status,
    'cheating_marked', v_attempt.cheating_marked,
    'ended_reason', v_attempt.ended_reason,
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
    'same_duration_per_q', v_t.same_duration_per_q,
    'total_duration_minutes', v_t.total_duration_minutes,
    'question_durations', v_t.question_durations,
    'answers', v_attempt.answers,
    'questions', v_sanitized_qs
  );
END;
$$;
