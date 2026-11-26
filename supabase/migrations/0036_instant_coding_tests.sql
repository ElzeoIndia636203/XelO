-- Instant coding tests: faculty-created quick coding assessments with test code,
-- topic, marks, difficulty, CO mapping, visible/hidden test cases & marks,
-- allowed languages, and student attendance by PRN + Name.

CREATE TABLE instant_tests (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  institution_id uuid NOT NULL REFERENCES institutions(id) ON DELETE CASCADE,
  course_id uuid NOT NULL REFERENCES courses(id) ON DELETE CASCADE,
  created_by uuid NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
  test_code text NOT NULL UNIQUE,
  topic text NOT NULL,
  total_marks numeric(6,2) NOT NULL CHECK (total_marks > 0),
  question_count integer NOT NULL CHECK (question_count BETWEEN 1 AND 20),
  difficulty text NOT NULL CHECK (difficulty IN ('easy', 'medium', 'hard', 'mixed')),
  co_id uuid REFERENCES course_outcomes(id) ON DELETE SET NULL,
  co_code text NOT NULL DEFAULT '',
  visible_count integer NOT NULL DEFAULT 2 CHECK (visible_count BETWEEN 1 AND 10),
  hidden_count integer NOT NULL DEFAULT 3 CHECK (hidden_count BETWEEN 0 AND 10),
  visible_marks numeric(6,2) NOT NULL DEFAULT 5 CHECK (visible_marks >= 0),
  hidden_marks numeric(6,2) NOT NULL DEFAULT 5 CHECK (hidden_marks >= 0),
  allowed_langs text[] NOT NULL DEFAULT ARRAY['c','cpp','java','python']::text[],
  questions jsonb NOT NULL DEFAULT '[]'::jsonb,
  active boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE instant_test_attempts (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  test_id uuid NOT NULL REFERENCES instant_tests(id) ON DELETE CASCADE,
  institution_id uuid NOT NULL REFERENCES institutions(id) ON DELETE CASCADE,
  student_id uuid NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
  prn text NOT NULL,
  student_name text NOT NULL,
  answers jsonb NOT NULL DEFAULT '{}'::jsonb,
  total_score numeric(6,2) NOT NULL DEFAULT 0,
  submitted_at timestamptz,
  started_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (test_id, student_id)
);

CREATE INDEX idx_instant_tests_course ON instant_tests(course_id, created_at DESC);
CREATE INDEX idx_instant_tests_code ON instant_tests(upper(test_code));
CREATE INDEX idx_instant_attempts_test ON instant_test_attempts(test_id, started_at DESC);

ALTER TABLE instant_tests ENABLE ROW LEVEL SECURITY;
ALTER TABLE instant_test_attempts ENABLE ROW LEVEL SECURITY;

GRANT SELECT ON instant_tests TO authenticated;
GRANT SELECT ON instant_test_attempts TO authenticated;
GRANT ALL ON instant_tests, instant_test_attempts TO service_role;

-- Only staff/faculty can read full instant_tests (students must go through student_join_instant_test so hidden_tests stay server-side).
CREATE POLICY instant_tests_staff_read ON instant_tests
  FOR SELECT TO authenticated
  USING (
    has_role('super_admin')
    OR is_course_faculty(course_id)
    OR can_oversee_course(course_id)
  );

CREATE POLICY instant_attempts_read ON instant_test_attempts
  FOR SELECT TO authenticated
  USING (
    student_id = auth.uid()
    OR has_role('super_admin')
    OR EXISTS (
      SELECT 1 FROM public.instant_tests t
      WHERE t.id = test_id
        AND (is_course_faculty(t.course_id) OR can_oversee_course(t.course_id))
    )
  );

CREATE OR REPLACE FUNCTION generate_instant_test_code()
RETURNS text
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_chars constant text := 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  v_code text;
  v_i integer;
BEGIN
  LOOP
    v_code := '';
    FOR v_i IN 1..6 LOOP
      v_code := v_code || substr(v_chars, 1 + floor(random() * length(v_chars))::integer, 1);
    END LOOP;
    EXIT WHEN NOT EXISTS (SELECT 1 FROM public.instant_tests WHERE upper(test_code) = v_code);
  END LOOP;
  RETURN v_code;
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
     OR jsonb_typeof(p_questions) <> 'array'
     OR jsonb_array_length(p_questions) = 0
     OR coalesce(array_length(p_allowed_langs, 1), 0) = 0 THEN
    RAISE EXCEPTION 'invalid_input';
  END IF;

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
    jsonb_build_object('course_id', v_co.id, 'test_code', v_code, 'topic', trim(p_topic)),
    v_co.institution_id
  );

  RETURN jsonb_build_object('id', v_id, 'test_code', v_code);
END;
$$;

CREATE OR REPLACE FUNCTION faculty_toggle_instant_test(p_test_id uuid, p_active boolean)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_t public.instant_tests%ROWTYPE;
BEGIN
  SELECT * INTO v_t FROM public.instant_tests WHERE id = p_test_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'not_found';
  END IF;
  IF NOT is_course_faculty(v_t.course_id) AND NOT has_role('super_admin') THEN
    RAISE EXCEPTION 'forbidden';
  END IF;

  UPDATE public.instant_tests SET active = p_active WHERE id = p_test_id;
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
  v_sanitized_qs jsonb := '[]'::jsonb;
  v_q jsonb;
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

  INSERT INTO public.instant_test_attempts (
    test_id, institution_id, student_id, prn, student_name
  ) VALUES (
    v_t.id, v_t.institution_id, v_me.id, trim(p_prn), trim(p_name)
  )
  ON CONFLICT (test_id, student_id) DO UPDATE
    SET prn = EXCLUDED.prn,
        student_name = EXCLUDED.student_name
  RETURNING * INTO v_attempt;

  -- Strip hidden_tests before returning to student
  FOR v_q IN SELECT value FROM jsonb_array_elements(v_t.questions)
  LOOP
    v_sanitized_qs := v_sanitized_qs || jsonb_build_array(
      jsonb_build_object(
        'id', v_q->>'id',
        'title', v_q->>'title',
        'statement', v_q->>'statement',
        'difficulty', coalesce(v_q->>'difficulty', v_t.difficulty),
        'marks', coalesce((v_q->>'marks')::numeric, 0),
        'co_code', coalesce(v_q->>'co_code', v_t.co_code),
        'visible_tests', coalesce(v_q->'visible_tests', '[]'::jsonb),
        'hidden_count', jsonb_array_length(coalesce(v_q->'hidden_tests', '[]'::jsonb))
      )
    );
  END LOOP;

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
  v_sanitized_qs jsonb := '[]'::jsonb;
  v_q jsonb;
BEGIN
  SELECT * INTO v_attempt FROM public.instant_test_attempts WHERE id = p_attempt_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'not_found';
  END IF;
  IF v_attempt.student_id <> auth.uid() THEN
    RAISE EXCEPTION 'forbidden';
  END IF;

  SELECT * INTO v_t FROM public.instant_tests WHERE id = v_attempt.test_id;

  FOR v_q IN SELECT value FROM jsonb_array_elements(v_t.questions)
  LOOP
    v_sanitized_qs := v_sanitized_qs || jsonb_build_array(
      jsonb_build_object(
        'id', v_q->>'id',
        'title', v_q->>'title',
        'statement', v_q->>'statement',
        'difficulty', coalesce(v_q->>'difficulty', v_t.difficulty),
        'marks', coalesce((v_q->>'marks')::numeric, 0),
        'co_code', coalesce(v_q->>'co_code', v_t.co_code),
        'visible_tests', coalesce(v_q->'visible_tests', '[]'::jsonb),
        'hidden_count', jsonb_array_length(coalesce(v_q->'hidden_tests', '[]'::jsonb))
      )
    );
  END LOOP;

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

CREATE OR REPLACE FUNCTION student_submit_instant_test(p_attempt_id uuid)
RETURNS numeric
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_attempt public.instant_test_attempts%ROWTYPE;
BEGIN
  SELECT * INTO v_attempt FROM public.instant_test_attempts WHERE id = p_attempt_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'not_found';
  END IF;
  IF v_attempt.student_id <> auth.uid() THEN
    RAISE EXCEPTION 'forbidden';
  END IF;

  UPDATE public.instant_test_attempts
  SET submitted_at = coalesce(submitted_at, now())
  WHERE id = p_attempt_id;

  RETURN v_attempt.total_score;
END;
$$;

REVOKE ALL ON FUNCTION generate_instant_test_code() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION faculty_create_instant_test(uuid, text, numeric, integer, text, uuid, text, integer, integer, numeric, numeric, text[], jsonb) TO authenticated;
GRANT EXECUTE ON FUNCTION faculty_toggle_instant_test(uuid, boolean) TO authenticated;
GRANT EXECUTE ON FUNCTION student_join_instant_test(text, text, text) TO authenticated;
GRANT EXECUTE ON FUNCTION student_get_instant_attempt(uuid) TO authenticated;
GRANT EXECUTE ON FUNCTION student_submit_instant_test(uuid) TO authenticated;
