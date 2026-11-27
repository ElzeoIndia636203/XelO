-- Add per-question / total duration config to instant_tests and expose in student_get_instant_attempt
ALTER TABLE public.instant_tests
  ADD COLUMN IF NOT EXISTS same_duration_per_q boolean NOT NULL DEFAULT true,
  ADD COLUMN IF NOT EXISTS total_duration_minutes integer NOT NULL DEFAULT 60 CHECK (total_duration_minutes >= 1),
  ADD COLUMN IF NOT EXISTS question_durations jsonb NOT NULL DEFAULT '[]'::jsonb;

-- Drop 27-arg faculty_create_instant_test and recreate 30-arg with duration fields
DROP FUNCTION IF EXISTS faculty_create_instant_test(
  uuid, text, numeric, integer, text, uuid, text, integer, integer, numeric, numeric,
  text[], jsonb, text, uuid[], uuid[], timestamptz, boolean, integer, text, numeric, jsonb, numeric,
  integer, text, numeric, boolean
);

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
  p_questions jsonb,
  p_scope_type text DEFAULT 'class',
  p_target_batch_ids uuid[] DEFAULT '{}',
  p_target_student_ids uuid[] DEFAULT '{}',
  p_scheduled_at timestamptz DEFAULT NULL,
  p_activate_now boolean DEFAULT true,
  p_pretest_count integer DEFAULT 0,
  p_pretest_difficulty text DEFAULT 'medium',
  p_pretest_marks numeric DEFAULT 0,
  p_pretest_questions jsonb DEFAULT '[]'::jsonb,
  p_viva_marks numeric DEFAULT 0,
  p_posttest_count integer DEFAULT 0,
  p_posttest_difficulty text DEFAULT 'medium',
  p_posttest_marks numeric DEFAULT 0,
  p_mark_matrix_approved boolean DEFAULT true,
  p_same_duration_per_q boolean DEFAULT true,
  p_total_duration_minutes integer DEFAULT 60,
  p_question_durations jsonb DEFAULT '[]'::jsonb
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
  v_status text;
  v_att text;
  v_sid uuid;
  v_when_label text;
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
     OR p_pretest_count < 0
     OR p_pretest_marks < 0
     OR p_posttest_count < 0
     OR p_posttest_marks < 0
     OR p_viva_marks < 0
     OR p_total_duration_minutes < 1
     OR p_scope_type NOT IN ('class', 'batch', 'students')
     OR jsonb_typeof(p_questions) <> 'array'
     OR jsonb_array_length(p_questions) = 0
     OR coalesce(array_length(p_allowed_langs, 1), 0) = 0 THEN
    RAISE EXCEPTION 'invalid_input';
  END IF;

  v_code := public.generate_instant_test_code();
  v_status := CASE WHEN p_activate_now THEN 'active' ELSE 'scheduled' END;
  v_att := CASE WHEN p_activate_now THEN 'present' ELSE 'pending' END;

  INSERT INTO public.instant_tests (
    institution_id, course_id, created_by, test_code, topic, total_marks,
    question_count, difficulty, co_id, co_code, visible_count, hidden_count,
    visible_marks, hidden_marks, allowed_langs, questions, active,
    scope_type, target_batch_ids, target_student_ids, status,
    scheduled_at, activated_at, conducted_at,
    pretest_count, pretest_difficulty, pretest_marks, pretest_questions, viva_marks,
    posttest_count, posttest_difficulty, posttest_marks, mark_matrix_approved,
    same_duration_per_q, total_duration_minutes, question_durations
  ) VALUES (
    v_co.institution_id, v_co.id, auth.uid(), v_code, trim(p_topic), p_total_marks,
    p_question_count, p_difficulty, p_co_id, coalesce(trim(p_co_code), ''),
    p_visible_count, p_hidden_count, p_visible_marks, p_hidden_marks,
    p_allowed_langs, p_questions, p_activate_now,
    p_scope_type, COALESCE(p_target_batch_ids, '{}'), COALESCE(p_target_student_ids, '{}'), v_status,
    p_scheduled_at,
    CASE WHEN p_activate_now THEN now() ELSE NULL END,
    CASE WHEN p_activate_now THEN now() ELSE NULL END,
    p_pretest_count, coalesce(p_pretest_difficulty, 'medium'), p_pretest_marks,
    COALESCE(p_pretest_questions, '[]'::jsonb), p_viva_marks,
    p_posttest_count, coalesce(p_posttest_difficulty, 'medium'), p_posttest_marks,
    coalesce(p_mark_matrix_approved, true),
    coalesce(p_same_duration_per_q, true),
    greatest(1, coalesce(p_total_duration_minutes, 60)),
    COALESCE(p_question_durations, '[]'::jsonb)
  )
  RETURNING id INTO v_id;

  IF p_scope_type = 'class' THEN
    INSERT INTO public.instant_test_participants (test_id, institution_id, student_id, batch_id, attendance_status)
    SELECT v_id, v_co.institution_id, e.student_id, e.batch_id, v_att
    FROM public.enrollments e
    WHERE e.course_id = v_co.id
    ON CONFLICT (test_id, student_id) DO NOTHING;
  ELSIF p_scope_type = 'batch' THEN
    INSERT INTO public.instant_test_participants (test_id, institution_id, student_id, batch_id, attendance_status)
    SELECT v_id, v_co.institution_id, e.student_id, e.batch_id, v_att
    FROM public.enrollments e
    WHERE e.course_id = v_co.id
      AND e.batch_id = ANY(COALESCE(p_target_batch_ids, '{}'))
    ON CONFLICT (test_id, student_id) DO NOTHING;
  ELSE
    INSERT INTO public.instant_test_participants (test_id, institution_id, student_id, batch_id, attendance_status)
    SELECT v_id, v_co.institution_id, e.student_id, e.batch_id, v_att
    FROM public.enrollments e
    WHERE e.course_id = v_co.id
      AND e.student_id = ANY(COALESCE(p_target_student_ids, '{}'))
    ON CONFLICT (test_id, student_id) DO NOTHING;
  END IF;

  v_when_label := CASE
    WHEN p_activate_now THEN 'Live now'
    WHEN p_scheduled_at IS NOT NULL THEN
      'Scheduled for ' || to_char(p_scheduled_at AT TIME ZONE 'Asia/Kolkata', 'DD Mon YYYY HH24:MI') || ' IST'
    ELSE 'Scheduled'
  END;

  FOR v_sid IN
    SELECT p.student_id FROM public.instant_test_participants p WHERE p.test_id = v_id
  LOOP
    PERFORM public.notify(
      v_sid,
      'instant_test',
      v_co.code || ' coding test: ' || trim(p_topic),
      v_when_label || ' · Code ' || v_code || ' · ' || p_total_marks || ' marks.',
      '/app/student/instant',
      v_co.institution_id
    );
  END LOOP;

  PERFORM public.audit(
    'create_instant_test',
    'instant_test',
    v_id::text,
    jsonb_build_object(
      'course_id', v_co.id,
      'test_code', v_code,
      'topic', trim(p_topic),
      'scope_type', p_scope_type,
      'status', v_status,
      'total_duration_minutes', p_total_duration_minutes
    ),
    v_co.institution_id
  );

  RETURN jsonb_build_object('id', v_id, 'test_code', v_code, 'status', v_status);
END;
$$;

GRANT EXECUTE ON FUNCTION faculty_create_instant_test(
  uuid, text, numeric, integer, text, uuid, text, integer, integer, numeric, numeric,
  text[], jsonb, text, uuid[], uuid[], timestamptz, boolean, integer, text, numeric, jsonb, numeric,
  integer, text, numeric, boolean, boolean, integer, jsonb
) TO authenticated;

-- Update student_get_instant_attempt to include duration settings alongside randomized per-slot questions
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
    'same_duration_per_q', v_t.same_duration_per_q,
    'total_duration_minutes', v_t.total_duration_minutes,
    'question_durations', v_t.question_durations,
    'answers', v_attempt.answers,
    'questions', v_sanitized_qs
  );
END;
$$;
