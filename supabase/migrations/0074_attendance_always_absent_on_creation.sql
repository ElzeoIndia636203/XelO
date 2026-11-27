-- Fix: attendance_status must ALWAYS default to 'absent' when participants are
-- enrolled on test creation. Faculty must mark present manually every time.
-- Previously the code set 'present' when p_activate_now = true, which bypassed
-- the attendance gate completely.

-- 1. Repair any existing rows that were wrongly set to 'present' at creation time
--    (safe: only touches rows where the student has NOT yet opened an attempt,
--     i.e. there is no attempt row yet, so they haven't started).
UPDATE public.instant_test_participants itp
SET    attendance_status = 'absent'
WHERE  itp.attendance_status = 'present'
  AND  NOT EXISTS (
         SELECT 1 FROM public.instant_test_attempts ita
         WHERE  ita.test_id    = itp.test_id
           AND  ita.student_id = itp.student_id
       );

-- 2. Recreate faculty_create_instant_test with 'absent' hardcoded instead of
--    'present' when p_activate_now = true.
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

  v_code   := public.generate_instant_test_code();
  v_status := CASE WHEN p_activate_now THEN 'active' ELSE 'scheduled' END;
  -- Attendance is ALWAYS absent at creation — faculty marks present manually.

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

  -- All participants start as 'absent' — faculty must call
  -- faculty_confirm_attendance_and_activate to mark them present.
  IF p_scope_type = 'class' THEN
    INSERT INTO public.instant_test_participants (test_id, institution_id, student_id, batch_id, attendance_status)
    SELECT v_id, v_co.institution_id, e.student_id, e.batch_id, 'absent'
    FROM public.enrollments e
    WHERE e.course_id = v_co.id
    ON CONFLICT (test_id, student_id) DO NOTHING;
  ELSIF p_scope_type = 'batch' THEN
    INSERT INTO public.instant_test_participants (test_id, institution_id, student_id, batch_id, attendance_status)
    SELECT v_id, v_co.institution_id, e.student_id, e.batch_id, 'absent'
    FROM public.enrollments e
    WHERE e.course_id = v_co.id
      AND e.batch_id = ANY(COALESCE(p_target_batch_ids, '{}'))
    ON CONFLICT (test_id, student_id) DO NOTHING;
  ELSE
    INSERT INTO public.instant_test_participants (test_id, institution_id, student_id, batch_id, attendance_status)
    SELECT v_id, v_co.institution_id, e.student_id, e.batch_id, 'absent'
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
