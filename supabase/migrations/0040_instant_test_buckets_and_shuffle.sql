-- Instant coding test 15-question buckets per slot, per-student shuffling,
-- and mandatory minimum 1 visible + 1 hidden test case.

ALTER TABLE public.instant_tests
  DROP CONSTRAINT IF EXISTS instant_tests_hidden_count_check,
  ADD CONSTRAINT instant_tests_hidden_count_check CHECK (hidden_count BETWEEN 1 AND 10);

ALTER TABLE public.instant_test_attempts
  ADD COLUMN IF NOT EXISTS assigned_question_ids text[] NOT NULL DEFAULT '{}'::text[];

CREATE OR REPLACE FUNCTION sanitize_instant_questions_for_student(
  p_questions jsonb,
  p_assigned_ids text[],
  p_default_difficulty text,
  p_default_co text
)
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_out jsonb := '[]'::jsonb;
  v_qid text;
  v_q jsonb;
BEGIN
  IF coalesce(array_length(p_assigned_ids, 1), 0) > 0 THEN
    FOREACH v_qid IN ARRAY p_assigned_ids LOOP
      SELECT elem INTO v_q
      FROM jsonb_array_elements(p_questions) AS elem
      WHERE elem->>'id' = v_qid
      LIMIT 1;
      IF v_q IS NOT NULL THEN
        v_out := v_out || jsonb_build_array(
          jsonb_build_object(
            'id', v_q->>'id',
            'title', v_q->>'title',
            'statement', v_q->>'statement',
            'input_spec', coalesce(v_q->>'input_spec', ''),
            'output_spec', coalesce(v_q->>'output_spec', ''),
            'constraints', coalesce(v_q->>'constraints', ''),
            'sample_input', coalesce(v_q->>'sample_input', ''),
            'sample_output', coalesce(v_q->>'sample_output', ''),
            'difficulty', coalesce(v_q->>'difficulty', p_default_difficulty),
            'marks', coalesce((v_q->>'marks')::numeric, 0),
            'co_code', coalesce(v_q->>'co_code', p_default_co),
            'visible_tests', coalesce(v_q->'visible_tests', '[]'::jsonb),
            'hidden_count', jsonb_array_length(coalesce(v_q->'hidden_tests', '[]'::jsonb))
          )
        );
      END IF;
    END LOOP;
    RETURN v_out;
  END IF;

  -- Legacy fallback when assigned_question_ids is empty
  FOR v_q IN SELECT value FROM jsonb_array_elements(p_questions) LOOP
    v_out := v_out || jsonb_build_array(
      jsonb_build_object(
        'id', v_q->>'id',
        'title', v_q->>'title',
        'statement', v_q->>'statement',
        'input_spec', coalesce(v_q->>'input_spec', ''),
        'output_spec', coalesce(v_q->>'output_spec', ''),
        'constraints', coalesce(v_q->>'constraints', ''),
        'sample_input', coalesce(v_q->>'sample_input', ''),
        'sample_output', coalesce(v_q->>'sample_output', ''),
        'difficulty', coalesce(v_q->>'difficulty', p_default_difficulty),
        'marks', coalesce((v_q->>'marks')::numeric, 0),
        'co_code', coalesce(v_q->>'co_code', p_default_co),
        'visible_tests', coalesce(v_q->'visible_tests', '[]'::jsonb),
        'hidden_count', jsonb_array_length(coalesce(v_q->'hidden_tests', '[]'::jsonb))
      )
    );
  END LOOP;
  RETURN v_out;
END;
$$;

CREATE OR REPLACE FUNCTION faculty_create_instant_test(
  p_course_id uuid,
  p_topic text,
  p_total_marks numeric,
  p_question_count integer,
  p_difficulty text,
  p_co_id uuid,
  p_co_code text,
  p_visible_count integer,
  p_hidden_count integer,
  p_visible_marks numeric,
  p_hidden_marks numeric,
  p_allowed_langs text[],
  p_questions jsonb
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_co public.courses%ROWTYPE;
  v_code text;
  v_id uuid;
  v_q jsonb;
BEGIN
  IF NOT is_course_faculty(p_course_id) AND NOT has_role('super_admin') THEN
    RAISE EXCEPTION 'forbidden';
  END IF;

  SELECT * INTO v_co FROM public.courses WHERE id = p_course_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'not_found';
  END IF;

  IF trim(coalesce(p_topic, '')) = ''
     OR p_total_marks <= 0
     OR p_question_count < 1
     OR p_visible_count < 1
     OR p_hidden_count < 1
     OR jsonb_typeof(p_questions) <> 'array'
     OR jsonb_array_length(p_questions) = 0
     OR coalesce(array_length(p_allowed_langs, 1), 0) = 0 THEN
    RAISE EXCEPTION 'invalid_input';
  END IF;

  FOR v_q IN SELECT value FROM jsonb_array_elements(p_questions) LOOP
    IF jsonb_array_length(coalesce(v_q->'visible_tests', '[]'::jsonb)) < 1
       OR jsonb_array_length(coalesce(v_q->'hidden_tests', '[]'::jsonb)) < 1 THEN
      RAISE EXCEPTION 'invalid_input';
    END IF;
  END LOOP;

  v_code := public.generate_instant_test_code();

  INSERT INTO public.instant_tests (
    institution_id, course_id, created_by, test_code, topic, total_marks,
    question_count, difficulty, co_id, co_code, visible_count, hidden_count,
    visible_marks, hidden_marks, allowed_langs, questions, active
  ) VALUES (
    v_co.institution_id, v_co.id, auth.uid(), v_code, trim(p_topic), p_total_marks,
    p_question_count, p_difficulty, p_co_id, coalesce(trim(p_co_code), ''),
    p_visible_count, p_hidden_count, p_visible_marks, p_hidden_marks,
    p_allowed_langs, p_questions, true
  )
  RETURNING id INTO v_id;

  PERFORM public.audit(
    'create_instant_test',
    'instant_test',
    v_id::text,
    jsonb_build_object(
      'course_id', v_co.id,
      'test_code', v_code,
      'topic', trim(p_topic),
      'bank_size', jsonb_array_length(p_questions)
    ),
    v_co.institution_id
  );

  RETURN jsonb_build_object('id', v_id, 'test_code', v_code);
END;
$$;

CREATE OR REPLACE FUNCTION student_join_instant_test(
  p_code text,
  p_prn text,
  p_name text
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_me public.profiles%ROWTYPE;
  v_t public.instant_tests%ROWTYPE;
  v_attempt public.instant_test_attempts%ROWTYPE;
  v_picked text[] := '{}'::text[];
  v_slot integer;
  v_qid text;
  v_has_slots boolean;
  v_sanitized_qs jsonb;
BEGIN
  SELECT * INTO v_me FROM public.profiles WHERE id = auth.uid() AND active = true;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'forbidden';
  END IF;

  IF trim(coalesce(p_prn, '')) = '' OR trim(coalesce(p_name, '')) = '' OR trim(coalesce(p_code, '')) = '' THEN
    RAISE EXCEPTION 'invalid_input';
  END IF;

  SELECT * INTO v_t
  FROM public.instant_tests
  WHERE upper(test_code) = upper(trim(p_code))
    AND active = true
    AND (v_me.institution_id IS NULL OR institution_id = v_me.institution_id)
  LIMIT 1;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'not_found';
  END IF;

  SELECT * INTO v_attempt
  FROM public.instant_test_attempts
  WHERE test_id = v_t.id AND student_id = v_me.id;

  IF NOT FOUND OR coalesce(array_length(v_attempt.assigned_question_ids, 1), 0) = 0 THEN
    SELECT EXISTS (
      SELECT 1 FROM jsonb_array_elements(v_t.questions) AS elem
      WHERE elem ? 'slot'
    ) INTO v_has_slots;

    IF v_has_slots THEN
      FOR v_slot IN 1..v_t.question_count LOOP
        SELECT elem->>'id' INTO v_qid
        FROM jsonb_array_elements(v_t.questions) AS elem
        WHERE (elem->>'slot')::integer = v_slot
        ORDER BY random()
        LIMIT 1;
        IF v_qid IS NOT NULL THEN
          v_picked := array_append(v_picked, v_qid);
        END IF;
      END LOOP;
      -- Shuffle the picked questions across slots for each student
      SELECT ARRAY(
        SELECT qid FROM unnest(v_picked) AS qid ORDER BY random()
      ) INTO v_picked;
    ELSE
      SELECT ARRAY(
        SELECT elem->>'id'
        FROM jsonb_array_elements(v_t.questions) AS elem
        ORDER BY random()
        LIMIT v_t.question_count
      ) INTO v_picked;
    END IF;
  ELSE
    v_picked := v_attempt.assigned_question_ids;
  END IF;

  INSERT INTO public.instant_test_attempts (
    test_id, institution_id, student_id, prn, student_name, assigned_question_ids
  ) VALUES (
    v_t.id, v_t.institution_id, v_me.id, trim(p_prn), trim(p_name), v_picked
  )
  ON CONFLICT (test_id, student_id) DO UPDATE
    SET prn = EXCLUDED.prn,
        student_name = EXCLUDED.student_name,
        assigned_question_ids = CASE
          WHEN coalesce(array_length(public.instant_test_attempts.assigned_question_ids, 1), 0) > 0
          THEN public.instant_test_attempts.assigned_question_ids
          ELSE EXCLUDED.assigned_question_ids
        END
  RETURNING * INTO v_attempt;

  v_sanitized_qs := public.sanitize_instant_questions_for_student(
    v_t.questions,
    v_attempt.assigned_question_ids,
    v_t.difficulty,
    v_t.co_code
  );

  RETURN jsonb_build_object(
    'attempt_id', v_attempt.id,
    'test_id', v_t.id,
    'test_code', v_t.test_code,
    'topic', v_t.topic,
    'total_marks', v_t.total_marks,
    'allowed_langs', v_t.allowed_langs,
    'prn', v_attempt.prn,
    'student_name', v_attempt.student_name,
    'submitted_at', v_attempt.submitted_at,
    'total_score', v_attempt.total_score,
    'answers', v_attempt.answers,
    'questions', v_sanitized_qs
  );
END;
$$;

CREATE OR REPLACE FUNCTION student_get_instant_attempt(p_attempt_id uuid)
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_attempt public.instant_test_attempts%ROWTYPE;
  v_t public.instant_tests%ROWTYPE;
  v_sanitized_qs jsonb;
BEGIN
  SELECT * INTO v_attempt FROM public.instant_test_attempts WHERE id = p_attempt_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'not_found';
  END IF;
  IF v_attempt.student_id <> auth.uid() THEN
    RAISE EXCEPTION 'forbidden';
  END IF;

  SELECT * INTO v_t FROM public.instant_tests WHERE id = v_attempt.test_id;

  v_sanitized_qs := public.sanitize_instant_questions_for_student(
    v_t.questions,
    v_attempt.assigned_question_ids,
    v_t.difficulty,
    v_t.co_code
  );

  RETURN jsonb_build_object(
    'attempt_id', v_attempt.id,
    'test_id', v_t.id,
    'test_code', v_t.test_code,
    'topic', v_t.topic,
    'total_marks', v_t.total_marks,
    'allowed_langs', v_t.allowed_langs,
    'prn', v_attempt.prn,
    'student_name', v_attempt.student_name,
    'submitted_at', v_attempt.submitted_at,
    'total_score', v_attempt.total_score,
    'answers', v_attempt.answers,
    'questions', v_sanitized_qs
  );
END;
$$;

GRANT EXECUTE ON FUNCTION sanitize_instant_questions_for_student(jsonb, text[], text, text) TO authenticated;
