-- Upgrade instant_tests lifecycle:
-- 1. Targeting (whole class / particular batches / particular students) & live student addition
-- 2. Scheduling + exam-day attendance confirmation & activation
-- 3. Rubrics (optional pretest MCQs & viva with 0 weightage allowed; >= 1 visible & >= 1 hidden mandatory)
-- 4. Code inspection with decrease-only mark override, viva entry, and final marks approval

ALTER TABLE public.instant_tests
  ADD COLUMN IF NOT EXISTS scope_type text NOT NULL DEFAULT 'class'
    CHECK (scope_type IN ('class', 'batch', 'students')),
  ADD COLUMN IF NOT EXISTS target_batch_ids uuid[] NOT NULL DEFAULT '{}',
  ADD COLUMN IF NOT EXISTS target_student_ids uuid[] NOT NULL DEFAULT '{}',
  ADD COLUMN IF NOT EXISTS status text NOT NULL DEFAULT 'active'
    CHECK (status IN ('scheduled', 'active', 'closed', 'finalized')),
  ADD COLUMN IF NOT EXISTS scheduled_at timestamptz,
  ADD COLUMN IF NOT EXISTS activated_at timestamptz,
  ADD COLUMN IF NOT EXISTS conducted_at timestamptz,
  ADD COLUMN IF NOT EXISTS pretest_count integer NOT NULL DEFAULT 0
    CHECK (pretest_count BETWEEN 0 AND 20),
  ADD COLUMN IF NOT EXISTS pretest_difficulty text NOT NULL DEFAULT 'medium'
    CHECK (pretest_difficulty IN ('easy', 'medium', 'hard', 'mixed')),
  ADD COLUMN IF NOT EXISTS pretest_marks numeric(6,2) NOT NULL DEFAULT 0
    CHECK (pretest_marks >= 0),
  ADD COLUMN IF NOT EXISTS pretest_questions jsonb NOT NULL DEFAULT '[]'::jsonb,
  ADD COLUMN IF NOT EXISTS viva_marks numeric(6,2) NOT NULL DEFAULT 0
    CHECK (viva_marks >= 0);

UPDATE public.instant_tests
SET hidden_count = 1
WHERE hidden_count < 1;

ALTER TABLE public.instant_tests
  DROP CONSTRAINT IF EXISTS instant_tests_hidden_count_check;
ALTER TABLE public.instant_tests
  ADD CONSTRAINT instant_tests_hidden_count_check CHECK (hidden_count BETWEEN 1 AND 10);

CREATE TABLE IF NOT EXISTS public.instant_test_participants (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  test_id uuid NOT NULL REFERENCES public.instant_tests(id) ON DELETE CASCADE,
  institution_id uuid NOT NULL REFERENCES public.institutions(id) ON DELETE CASCADE,
  student_id uuid NOT NULL REFERENCES public.profiles(id) ON DELETE CASCADE,
  batch_id uuid REFERENCES public.batches(id) ON DELETE SET NULL,
  attendance_status text NOT NULL DEFAULT 'pending'
    CHECK (attendance_status IN ('pending', 'present', 'absent')),
  added_manually boolean NOT NULL DEFAULT false,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (test_id, student_id)
);

CREATE INDEX IF NOT EXISTS idx_instant_participants_test ON public.instant_test_participants(test_id);
CREATE INDEX IF NOT EXISTS idx_instant_participants_student ON public.instant_test_participants(student_id);

ALTER TABLE public.instant_test_participants ENABLE ROW LEVEL SECURITY;
GRANT SELECT ON public.instant_test_participants TO authenticated;
GRANT ALL ON public.instant_test_participants TO service_role;

DROP POLICY IF EXISTS instant_participants_read ON public.instant_test_participants;
CREATE POLICY instant_participants_read ON public.instant_test_participants
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

ALTER TABLE public.instant_test_attempts
  ADD COLUMN IF NOT EXISTS pretest_answers jsonb NOT NULL DEFAULT '{}'::jsonb,
  ADD COLUMN IF NOT EXISTS pretest_score numeric(6,2) NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS coding_score numeric(6,2) NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS coding_override_score numeric(6,2),
  ADD COLUMN IF NOT EXISTS override_reason text NOT NULL DEFAULT '',
  ADD COLUMN IF NOT EXISTS code_approved boolean NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS viva_score numeric(6,2) NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS final_score numeric(6,2) NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS marks_approved boolean NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS approved_at timestamptz,
  ADD COLUMN IF NOT EXISTS approved_by uuid REFERENCES public.profiles(id) ON DELETE SET NULL;

UPDATE public.instant_test_attempts
SET coding_score = total_score,
    final_score = total_score
WHERE coding_score = 0 AND total_score > 0;

DROP FUNCTION IF EXISTS faculty_create_instant_test(
  uuid, text, numeric, integer, text, uuid, text, integer, integer, numeric, numeric, text[], jsonb
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
  p_viva_marks numeric DEFAULT 0
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
     OR p_viva_marks < 0
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
    pretest_count, pretest_difficulty, pretest_marks, pretest_questions, viva_marks
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
    COALESCE(p_pretest_questions, '[]'::jsonb), p_viva_marks
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
      v_co.institution_id,
      'instant_test',
      v_co.code || ' coding test: ' || trim(p_topic),
      v_when_label || ' · Code ' || v_code || ' · ' || p_total_marks || ' marks.',
      '/app/student/instant'
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
      'status', v_status
    ),
    v_co.institution_id
  );

  RETURN jsonb_build_object('id', v_id, 'test_code', v_code, 'status', v_status);
END;
$$;

CREATE OR REPLACE FUNCTION faculty_add_instant_test_students(
  p_test_id uuid,
  p_student_ids uuid[]
)
RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_t public.instant_tests%ROWTYPE;
  v_co public.courses%ROWTYPE;
  v_att text;
  v_added integer := 0;
  v_sid uuid;
BEGIN
  SELECT * INTO v_t FROM public.instant_tests WHERE id = p_test_id;
  IF NOT FOUND THEN RAISE EXCEPTION 'not_found'; END IF;

  IF NOT is_course_faculty(v_t.course_id) AND NOT has_role('super_admin') THEN
    RAISE EXCEPTION 'forbidden';
  END IF;

  IF v_t.status = 'finalized' THEN
    RAISE EXCEPTION 'not_editable';
  END IF;

  SELECT * INTO v_co FROM public.courses WHERE id = v_t.course_id;
  v_att := CASE WHEN v_t.status = 'active' THEN 'present' ELSE 'pending' END;

  INSERT INTO public.instant_test_participants (
    test_id, institution_id, student_id, batch_id, attendance_status, added_manually
  )
  SELECT v_t.id, v_t.institution_id, e.student_id, e.batch_id, v_att, true
  FROM public.enrollments e
  WHERE e.course_id = v_t.course_id
    AND e.student_id = ANY(COALESCE(p_student_ids, '{}'))
  ON CONFLICT (test_id, student_id) DO UPDATE
    SET attendance_status = CASE
      WHEN v_t.status = 'active' THEN 'present'
      ELSE public.instant_test_participants.attendance_status
    END,
        added_manually = true;

  GET DIAGNOSTICS v_added = ROW_COUNT;

  FOREACH v_sid IN ARRAY COALESCE(p_student_ids, '{}') LOOP
    PERFORM public.notify(
      v_sid,
      v_t.institution_id,
      'instant_test',
      v_co.code || ' coding test: ' || v_t.topic,
      'You were assigned to this coding test · Code ' || v_t.test_code || '.',
      '/app/student/instant'
    );
  END LOOP;

  RETURN v_added;
END;
$$;

CREATE OR REPLACE FUNCTION faculty_confirm_attendance_and_activate(
  p_test_id uuid,
  p_present_student_ids uuid[]
)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_t public.instant_tests%ROWTYPE;
  v_co public.courses%ROWTYPE;
  v_sid uuid;
BEGIN
  SELECT * INTO v_t FROM public.instant_tests WHERE id = p_test_id;
  IF NOT FOUND THEN RAISE EXCEPTION 'not_found'; END IF;

  IF NOT is_course_faculty(v_t.course_id) AND NOT has_role('super_admin') THEN
    RAISE EXCEPTION 'forbidden';
  END IF;

  IF v_t.status = 'finalized' THEN
    RAISE EXCEPTION 'not_editable';
  END IF;

  SELECT * INTO v_co FROM public.courses WHERE id = v_t.course_id;

  UPDATE public.instant_test_participants
  SET attendance_status = CASE
    WHEN student_id = ANY(COALESCE(p_present_student_ids, '{}')) THEN 'present'
    ELSE 'absent'
  END
  WHERE test_id = p_test_id;

  UPDATE public.instant_tests
  SET status = 'active',
      active = true,
      activated_at = COALESCE(activated_at, now()),
      conducted_at = COALESCE(conducted_at, now())
  WHERE id = p_test_id;

  FOR v_sid IN
    SELECT p.student_id
    FROM public.instant_test_participants p
    WHERE p.test_id = p_test_id AND p.attendance_status = 'present'
  LOOP
    PERFORM public.notify(
      v_sid,
      v_t.institution_id,
      'instant_test',
      v_co.code || ' coding test is now live: ' || v_t.topic,
      'Attendance confirmed. Click to open the assessment portal · Code ' || v_t.test_code || '.',
      '/app/student/instant'
    );
  END LOOP;

  PERFORM public.audit(
    'activate_instant_test',
    'instant_test',
    p_test_id::text,
    jsonb_build_object('present_count', COALESCE(array_length(p_present_student_ids, 1), 0)),
    v_t.institution_id
  );
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
  IF v_t.status = 'finalized' THEN
    RAISE EXCEPTION 'not_editable';
  END IF;

  UPDATE public.instant_tests
  SET active = p_active,
      status = CASE WHEN p_active THEN 'active' ELSE 'closed' END,
      activated_at = CASE WHEN p_active AND activated_at IS NULL THEN now() ELSE activated_at END,
      conducted_at = CASE WHEN p_active AND conducted_at IS NULL THEN now() ELSE conducted_at END
  WHERE id = p_test_id;
END;
$$;

CREATE OR REPLACE FUNCTION student_list_instant_tests()
RETURNS TABLE (
  test_id uuid,
  course_id uuid,
  course_code text,
  course_title text,
  test_code text,
  topic text,
  total_marks numeric,
  pretest_count integer,
  pretest_marks numeric,
  viva_marks numeric,
  status text,
  active boolean,
  scheduled_at timestamptz,
  attendance_status text,
  attempt_id uuid,
  submitted_at timestamptz,
  final_score numeric,
  marks_approved boolean
)
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_uid uuid := auth.uid();
BEGIN
  IF v_uid IS NULL THEN
    RAISE EXCEPTION 'forbidden';
  END IF;

  RETURN QUERY
  SELECT
    t.id AS test_id,
    t.course_id,
    c.code AS course_code,
    c.title AS course_title,
    t.test_code,
    t.topic,
    t.total_marks,
    t.pretest_count,
    t.pretest_marks,
    t.viva_marks,
    t.status,
    t.active,
    t.scheduled_at,
    COALESCE(pt.attendance_status, 'present') AS attendance_status,
    a.id AS attempt_id,
    a.submitted_at,
    a.final_score,
    COALESCE(a.marks_approved, false) AS marks_approved
  FROM public.instant_tests t
  JOIN public.courses c ON c.id = t.course_id
  LEFT JOIN public.instant_test_participants pt
    ON pt.test_id = t.id AND pt.student_id = v_uid
  LEFT JOIN public.instant_test_attempts a
    ON a.test_id = t.id AND a.student_id = v_uid
  WHERE (
    pt.student_id = v_uid
    OR (
      t.scope_type = 'class'
      AND EXISTS (
        SELECT 1 FROM public.enrollments e
        WHERE e.course_id = t.course_id AND e.student_id = v_uid
      )
    )
  )
  ORDER BY
    CASE t.status WHEN 'active' THEN 0 WHEN 'scheduled' THEN 1 ELSE 2 END,
    COALESCE(t.scheduled_at, t.created_at) DESC;
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
BEGIN
  SELECT * INTO v_me FROM public.profiles WHERE id = auth.uid() AND active = true;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'forbidden';
  END IF;

  SELECT * INTO v_t FROM public.instant_tests WHERE id = p_test_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'not_found';
  END IF;

  IF v_t.status <> 'active' OR NOT v_t.active THEN
    RAISE EXCEPTION 'session_not_open';
  END IF;

  SELECT * INTO v_pt
  FROM public.instant_test_participants
  WHERE test_id = p_test_id AND student_id = v_me.id;

  IF FOUND THEN
    IF v_pt.attendance_status <> 'present' THEN
      RAISE EXCEPTION 'student_absent';
    END IF;
  ELSE
    IF v_t.scope_type <> 'class' OR NOT EXISTS (
      SELECT 1 FROM public.enrollments e WHERE e.course_id = v_t.course_id AND e.student_id = v_me.id
    ) THEN
      RAISE EXCEPTION 'forbidden';
    END IF;
  END IF;

  INSERT INTO public.instant_test_attempts (
    test_id, institution_id, student_id, prn, student_name
  ) VALUES (
    v_t.id,
    v_t.institution_id,
    v_me.id,
    COALESCE(NULLIF(trim(v_me.roll_no), ''), v_me.email),
    v_me.full_name
  )
  ON CONFLICT (test_id, student_id) DO UPDATE
    SET prn = COALESCE(NULLIF(trim(v_me.roll_no), ''), public.instant_test_attempts.prn),
        student_name = v_me.full_name
  RETURNING * INTO v_attempt;

  RETURN public.student_get_instant_attempt(v_attempt.id);
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
  v_sanitized_pre jsonb := '[]'::jsonb;
  v_q jsonb;
  v_pq jsonb;
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

CREATE OR REPLACE FUNCTION student_submit_instant_pretest(
  p_attempt_id uuid,
  p_answers jsonb
)
RETURNS numeric
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_attempt public.instant_test_attempts%ROWTYPE;
  v_t public.instant_tests%ROWTYPE;
  v_pq jsonb;
  v_total_q integer;
  v_correct integer := 0;
  v_picked integer;
  v_ans_text text;
  v_score numeric(6,2) := 0;
  v_eff_coding numeric(6,2);
BEGIN
  SELECT * INTO v_attempt FROM public.instant_test_attempts WHERE id = p_attempt_id;
  IF NOT FOUND THEN RAISE EXCEPTION 'not_found'; END IF;
  IF v_attempt.student_id <> auth.uid() THEN RAISE EXCEPTION 'forbidden'; END IF;

  SELECT * INTO v_t FROM public.instant_tests WHERE id = v_attempt.test_id;
  IF v_t.status <> 'active' OR NOT v_t.active THEN
    RAISE EXCEPTION 'test_closed';
  END IF;

  v_total_q := jsonb_array_length(COALESCE(v_t.pretest_questions, '[]'::jsonb));
  IF v_total_q > 0 AND v_t.pretest_marks > 0 THEN
    FOR v_pq IN SELECT value FROM jsonb_array_elements(v_t.pretest_questions)
    LOOP
      v_ans_text := p_answers->>(v_pq->>'id');
      IF v_ans_text ~ '^\d+$' THEN
        v_picked := v_ans_text::integer;
        IF v_picked = COALESCE((v_pq->>'correct_index')::integer, -1) THEN
          v_correct := v_correct + 1;
        END IF;
      END IF;
    END LOOP;
    v_score := round((v_correct::numeric / v_total_q::numeric) * v_t.pretest_marks, 2);
  END IF;

  v_eff_coding := COALESCE(v_attempt.coding_override_score, v_attempt.coding_score, 0);

  UPDATE public.instant_test_attempts
  SET pretest_answers = COALESCE(p_answers, '{}'::jsonb),
      pretest_score = v_score,
      final_score = round(v_score + v_eff_coding + COALESCE(viva_score, 0), 2)
  WHERE id = p_attempt_id;

  RETURN v_score;
END;
$$;

CREATE OR REPLACE FUNCTION faculty_inspect_and_grade_instant_attempt(
  p_attempt_id uuid,
  p_approve_code boolean,
  p_override_coding_score numeric DEFAULT NULL,
  p_override_reason text DEFAULT '',
  p_viva_score numeric DEFAULT 0
)
RETURNS numeric
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_attempt public.instant_test_attempts%ROWTYPE;
  v_t public.instant_tests%ROWTYPE;
  v_eff_coding numeric(6,2);
  v_final numeric(6,2);
BEGIN
  SELECT * INTO v_attempt FROM public.instant_test_attempts WHERE id = p_attempt_id;
  IF NOT FOUND THEN RAISE EXCEPTION 'not_found'; END IF;

  SELECT * INTO v_t FROM public.instant_tests WHERE id = v_attempt.test_id;
  IF NOT is_course_faculty(v_t.course_id) AND NOT has_role('super_admin') THEN
    RAISE EXCEPTION 'forbidden';
  END IF;

  IF p_override_coding_score IS NOT NULL THEN
    IF p_override_coding_score < 0 THEN
      RAISE EXCEPTION 'invalid_input';
    END IF;
    -- Faculty may only decrease (never increase) obtained coding marks.
    IF p_override_coding_score > v_attempt.coding_score THEN
      RAISE EXCEPTION 'override_cannot_increase';
    END IF;
    v_eff_coding := round(p_override_coding_score, 2);
  ELSE
    v_eff_coding := v_attempt.coding_score;
  END IF;

  IF COALESCE(p_viva_score, 0) < 0 OR COALESCE(p_viva_score, 0) > v_t.viva_marks THEN
    RAISE EXCEPTION 'viva_exceeds_rubric';
  END IF;

  v_final := round(
    COALESCE(v_attempt.pretest_score, 0) + v_eff_coding + COALESCE(p_viva_score, 0),
    2
  );

  UPDATE public.instant_test_attempts
  SET coding_override_score = CASE WHEN p_override_coding_score IS NOT NULL THEN v_eff_coding ELSE NULL END,
      override_reason = COALESCE(trim(p_override_reason), ''),
      code_approved = COALESCE(p_approve_code, false),
      viva_score = round(COALESCE(p_viva_score, 0), 2),
      total_score = v_final,
      final_score = v_final
  WHERE id = p_attempt_id;

  PERFORM public.audit(
    'grade_instant_attempt',
    'instant_test_attempt',
    p_attempt_id::text,
    jsonb_build_object(
      'coding_score', v_attempt.coding_score,
      'override', p_override_coding_score,
      'viva_score', p_viva_score,
      'final_score', v_final
    ),
    v_t.institution_id
  );

  RETURN v_final;
END;
$$;

CREATE OR REPLACE FUNCTION faculty_finalize_instant_test_marks(p_test_id uuid)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_t public.instant_tests%ROWTYPE;
BEGIN
  SELECT * INTO v_t FROM public.instant_tests WHERE id = p_test_id;
  IF NOT FOUND THEN RAISE EXCEPTION 'not_found'; END IF;

  IF NOT is_course_faculty(v_t.course_id) AND NOT has_role('super_admin') THEN
    RAISE EXCEPTION 'forbidden';
  END IF;

  UPDATE public.instant_test_attempts
  SET code_approved = true,
      marks_approved = true,
      approved_at = now(),
      approved_by = auth.uid(),
      final_score = round(
        COALESCE(pretest_score, 0)
        + COALESCE(coding_override_score, coding_score, 0)
        + COALESCE(viva_score, 0),
        2
      ),
      total_score = round(
        COALESCE(pretest_score, 0)
        + COALESCE(coding_override_score, coding_score, 0)
        + COALESCE(viva_score, 0),
        2
      )
  WHERE test_id = p_test_id;

  UPDATE public.instant_tests
  SET status = 'finalized',
      active = false
  WHERE id = p_test_id;

  PERFORM public.audit(
    'finalize_instant_test_marks',
    'instant_test',
    p_test_id::text,
    jsonb_build_object('topic', v_t.topic),
    v_t.institution_id
  );
END;
$$;

GRANT EXECUTE ON FUNCTION faculty_create_instant_test(
  uuid, text, numeric, integer, text, uuid, text, integer, integer, numeric, numeric, text[], jsonb,
  text, uuid[], uuid[], timestamptz, boolean, integer, text, numeric, jsonb, numeric
) TO authenticated;
GRANT EXECUTE ON FUNCTION faculty_add_instant_test_students(uuid, uuid[]) TO authenticated;
GRANT EXECUTE ON FUNCTION faculty_confirm_attendance_and_activate(uuid, uuid[]) TO authenticated;
GRANT EXECUTE ON FUNCTION faculty_toggle_instant_test(uuid, boolean) TO authenticated;
GRANT EXECUTE ON FUNCTION student_list_instant_tests() TO authenticated;
GRANT EXECUTE ON FUNCTION student_start_course_instant_test(uuid) TO authenticated;
GRANT EXECUTE ON FUNCTION student_submit_instant_pretest(uuid, jsonb) TO authenticated;
GRANT EXECUTE ON FUNCTION faculty_inspect_and_grade_instant_attempt(uuid, boolean, numeric, text, numeric) TO authenticated;
GRANT EXECUTE ON FUNCTION faculty_finalize_instant_test_marks(uuid) TO authenticated;
