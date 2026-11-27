-- Fix public.notify() argument order in 0062 and 0063 RPCs:
-- Signature: notify(p_user_id uuid, p_kind text, p_title text, p_body text, p_link text, p_institution_id uuid)

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
      'instant_test',
      v_co.code || ' coding test: ' || v_t.topic,
      'You were assigned to this coding test · Code ' || v_t.test_code || '.',
      '/app/student/instant',
      v_t.institution_id
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
      'instant_test',
      v_co.code || ' coding test is now live: ' || v_t.topic,
      'Attendance confirmed. Click to open the assessment portal · Code ' || v_t.test_code || '.',
      '/app/student/instant',
      v_t.institution_id
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

CREATE OR REPLACE FUNCTION student_request_join_class(p_code text)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_uid uuid := auth.uid();
  v_prof public.profiles%ROWTYPE;
  v_batch public.batches%ROWTYPE;
  v_course public.courses%ROWTYPE;
  v_clean text := upper(trim(coalesce(p_code, '')));
  v_req public.class_join_requests%ROWTYPE;
BEGIN
  IF v_uid IS NULL THEN
    RAISE EXCEPTION 'forbidden';
  END IF;

  SELECT * INTO v_prof FROM public.profiles WHERE id = v_uid AND active = true;
  IF NOT FOUND OR v_prof.role <> 'student' THEN
    RAISE EXCEPTION 'forbidden';
  END IF;

  SELECT * INTO v_batch FROM public.batches WHERE upper(class_code) = v_clean;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'invalid_class_code';
  END IF;

  IF v_prof.institution_id IS NOT NULL AND v_prof.institution_id <> v_batch.institution_id THEN
    RAISE EXCEPTION 'not_on_roster';
  END IF;

  IF EXISTS (SELECT 1 FROM public.enrollments WHERE course_id = v_batch.course_id AND student_id = v_uid) THEN
    RETURN jsonb_build_object(
      'status', 'already_enrolled',
      'course_id', v_batch.course_id,
      'batch_id', v_batch.id,
      'batch_name', v_batch.name
    );
  END IF;

  SELECT * INTO v_course FROM public.courses WHERE id = v_batch.course_id;

  INSERT INTO public.class_join_requests (
    course_id, batch_id, institution_id, student_id, status, requested_at, reviewed_by, reviewed_at
  ) VALUES (
    v_batch.course_id, v_batch.id, v_batch.institution_id, v_uid, 'pending', now(), NULL, NULL
  )
  ON CONFLICT (course_id, student_id) DO UPDATE
    SET batch_id = EXCLUDED.batch_id,
        status = 'pending',
        requested_at = now(),
        reviewed_by = NULL,
        reviewed_at = NULL
  RETURNING * INTO v_req;

  IF v_course.faculty_id IS NOT NULL THEN
    PERFORM public.notify(
      v_course.faculty_id,
      'class_join_request',
      'Class join request: ' || coalesce(v_prof.full_name, v_prof.email),
      coalesce(v_prof.roll_no, v_prof.email) || ' requested to join ' || v_course.code || ' (' || v_batch.name || ') using code ' || v_clean || '.',
      '/app/faculty/c/' || v_course.id || '/batches',
      v_batch.institution_id
    );
  END IF;

  PERFORM public.audit(
    'request_join_class',
    'class_join_request',
    v_req.id::text,
    jsonb_build_object('course_id', v_batch.course_id, 'batch_id', v_batch.id, 'class_code', v_clean),
    v_batch.institution_id
  );

  RETURN jsonb_build_object(
    'status', 'pending',
    'request_id', v_req.id,
    'course_id', v_batch.course_id,
    'course_code', v_course.code,
    'batch_id', v_batch.id,
    'batch_name', v_batch.name
  );
END;
$$;

CREATE OR REPLACE FUNCTION faculty_review_class_join_request(
  p_request_id uuid,
  p_approve boolean
)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_req public.class_join_requests%ROWTYPE;
  v_prof public.profiles%ROWTYPE;
  v_course public.courses%ROWTYPE;
BEGIN
  SELECT * INTO v_req FROM public.class_join_requests WHERE id = p_request_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'not_found';
  END IF;

  IF NOT (is_course_faculty(v_req.course_id) OR is_super_admin()) THEN
    RAISE EXCEPTION 'forbidden';
  END IF;

  SELECT * INTO v_prof FROM public.profiles WHERE id = v_req.student_id;
  SELECT * INTO v_course FROM public.courses WHERE id = v_req.course_id;

  IF p_approve THEN
    UPDATE public.class_join_requests
    SET status = 'approved',
        reviewed_by = me(),
        reviewed_at = now()
    WHERE id = v_req.id;

    INSERT INTO public.enrollments (course_id, batch_id, institution_id, student_id)
    VALUES (v_req.course_id, v_req.batch_id, v_req.institution_id, v_req.student_id)
    ON CONFLICT (course_id, student_id) DO NOTHING;

    IF v_prof.email IS NOT NULL THEN
      DELETE FROM public.pending_enrollments
      WHERE course_id = v_req.course_id AND lower(email) = lower(v_prof.email);
    END IF;

    PERFORM public.notify(
      v_req.student_id,
      'class_join_approved',
      'Approved: ' || v_course.code,
      'Your request to join ' || v_course.code || ' · ' || v_course.title || ' was approved by faculty.',
      '/app/student',
      v_req.institution_id
    );
  ELSE
    UPDATE public.class_join_requests
    SET status = 'rejected',
        reviewed_by = me(),
        reviewed_at = now()
    WHERE id = v_req.id;

    PERFORM public.notify(
      v_req.student_id,
      'class_join_declined',
      'Declined: ' || v_course.code,
      'Your request to join ' || v_course.code || ' was declined by faculty.',
      '/app/student',
      v_req.institution_id
    );
  END IF;

  PERFORM public.audit(
    CASE WHEN p_approve THEN 'approve_class_join_request' ELSE 'reject_class_join_request' END,
    'class_join_request',
    v_req.id::text,
    jsonb_build_object('course_id', v_req.course_id, 'student_id', v_req.student_id),
    v_req.institution_id
  );
END;
$$;

CREATE OR REPLACE FUNCTION student_request_join_instant_test(
  p_code text,
  p_prn text DEFAULT NULL,
  p_name text DEFAULT NULL
)
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
  v_clean text := upper(trim(coalesce(p_code, '')));
  v_prn text;
  v_name text;
BEGIN
  SELECT * INTO v_me FROM public.profiles WHERE id = auth.uid() AND active = true;
  IF NOT FOUND OR v_me.role <> 'student' THEN
    RAISE EXCEPTION 'forbidden';
  END IF;

  IF v_clean = '' THEN
    RAISE EXCEPTION 'invalid_input';
  END IF;

  SELECT * INTO v_t
  FROM public.instant_tests
  WHERE upper(test_code) = v_clean
    AND status IN ('scheduled', 'active')
    AND (v_me.institution_id IS NULL OR institution_id = v_me.institution_id)
  LIMIT 1;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'not_found';
  END IF;

  v_prn := coalesce(NULLIF(trim(coalesce(p_prn, '')), ''), NULLIF(trim(coalesce(v_me.roll_no, '')), ''), v_me.email);
  v_name := coalesce(NULLIF(trim(coalesce(p_name, '')), ''), NULLIF(trim(coalesce(v_me.full_name, '')), ''), v_me.email);

  SELECT * INTO v_pt
  FROM public.instant_test_participants
  WHERE test_id = v_t.id AND student_id = v_me.id;

  IF FOUND AND v_pt.approval_status = 'approved' THEN
    IF v_t.status = 'active' AND v_t.active = true AND v_pt.attendance_status <> 'absent' THEN
      INSERT INTO public.instant_test_attempts (
        test_id, institution_id, student_id, prn, student_name
      ) VALUES (
        v_t.id, v_t.institution_id, v_me.id, v_prn, v_name
      )
      ON CONFLICT (test_id, student_id) DO UPDATE
        SET prn = EXCLUDED.prn,
            student_name = EXCLUDED.student_name
      RETURNING * INTO v_attempt;

      RETURN jsonb_build_object(
        'status', 'approved',
        'attempt_id', v_attempt.id,
        'test_id', v_t.id,
        'topic', v_t.topic,
        'test_code', v_t.test_code
      );
    END IF;

    RETURN jsonb_build_object(
      'status', 'approved_waiting_start',
      'test_id', v_t.id,
      'topic', v_t.topic,
      'test_code', v_t.test_code
    );
  END IF;

  INSERT INTO public.instant_test_participants (
    test_id, institution_id, student_id, attendance_status,
    approval_status, requested_via_code, requested_prn, requested_name, requested_at
  ) VALUES (
    v_t.id, v_t.institution_id, v_me.id, 'pending',
    'pending', true, v_prn, v_name, now()
  )
  ON CONFLICT (test_id, student_id) DO UPDATE
    SET approval_status = 'pending',
        attendance_status = 'pending',
        requested_via_code = true,
        requested_prn = EXCLUDED.requested_prn,
        requested_name = EXCLUDED.requested_name,
        requested_at = now(),
        approved_by = NULL,
        approved_at = NULL;

  IF v_t.created_by IS NOT NULL THEN
    PERFORM public.notify(
      v_t.created_by,
      'instant_join_request',
      'Live test join request: ' || v_name,
      v_prn || ' requested to join "' || v_t.topic || '" using code ' || v_t.test_code || '.',
      '/app/faculty/c/' || v_t.course_id || '/instant',
      v_t.institution_id
    );
  END IF;

  PERFORM public.audit(
    'request_join_instant_test',
    'instant_test',
    v_t.id::text,
    jsonb_build_object('student_id', v_me.id, 'test_code', v_t.test_code),
    v_t.institution_id
  );

  RETURN jsonb_build_object(
    'status', 'pending',
    'test_id', v_t.id,
    'topic', v_t.topic,
    'test_code', v_t.test_code
  );
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
  v_pt public.instant_test_participants%ROWTYPE;
  v_attempt public.instant_test_attempts%ROWTYPE;
  v_sanitized_qs jsonb := '[]'::jsonb;
  v_q jsonb;
  v_prn text := trim(coalesce(p_prn, ''));
  v_name text := trim(coalesce(p_name, ''));
BEGIN
  SELECT * INTO v_me FROM public.profiles WHERE id = auth.uid() AND active = true;
  IF NOT FOUND OR v_me.role <> 'student' THEN
    RAISE EXCEPTION 'forbidden';
  END IF;

  IF v_prn = '' OR v_name = '' OR trim(coalesce(p_code, '')) = '' THEN
    RAISE EXCEPTION 'invalid_input';
  END IF;

  SELECT * INTO v_t
  FROM public.instant_tests
  WHERE upper(test_code) = upper(trim(p_code))
    AND status IN ('scheduled', 'active')
    AND (v_me.institution_id IS NULL OR institution_id = v_me.institution_id)
  LIMIT 1;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'not_found';
  END IF;

  SELECT * INTO v_pt
  FROM public.instant_test_participants
  WHERE test_id = v_t.id AND student_id = v_me.id;

  IF FOUND AND v_pt.approval_status = 'rejected' THEN
    RAISE EXCEPTION 'join_request_rejected';
  END IF;

  IF NOT FOUND OR v_pt.approval_status <> 'approved' THEN
    INSERT INTO public.instant_test_participants (
      test_id, institution_id, student_id, attendance_status,
      approval_status, requested_via_code, requested_prn, requested_name, requested_at
    ) VALUES (
      v_t.id, v_t.institution_id, v_me.id, 'pending',
      'pending', true, v_prn, v_name, now()
    )
    ON CONFLICT (test_id, student_id) DO UPDATE
      SET approval_status = 'pending',
          requested_via_code = true,
          requested_prn = EXCLUDED.requested_prn,
          requested_name = EXCLUDED.requested_name,
          requested_at = now();

    IF v_t.created_by IS NOT NULL THEN
      PERFORM public.notify(
        v_t.created_by,
        'instant_join_request',
        'Live test join request: ' || v_name,
        v_prn || ' requested to join "' || v_t.topic || '" using code ' || v_t.test_code || '.',
        '/app/faculty/c/' || v_t.course_id || '/instant',
        v_t.institution_id
      );
    END IF;

    RETURN jsonb_build_object(
      'status', 'pending',
      'test_id', v_t.id,
      'topic', v_t.topic,
      'test_code', v_t.test_code
    );
  END IF;

  IF v_t.status <> 'active' OR v_t.active <> true THEN
    RAISE EXCEPTION 'test_not_active';
  END IF;

  IF v_pt.attendance_status = 'absent' THEN
    RAISE EXCEPTION 'marked_absent';
  END IF;

  INSERT INTO public.instant_test_attempts (
    test_id, institution_id, student_id, prn, student_name
  ) VALUES (
    v_t.id, v_t.institution_id, v_me.id, v_prn, v_name
  )
  ON CONFLICT (test_id, student_id) DO UPDATE
    SET prn = EXCLUDED.prn,
        student_name = EXCLUDED.student_name
  RETURNING * INTO v_attempt;

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
    'status', 'approved',
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

CREATE OR REPLACE FUNCTION faculty_review_instant_join_request(
  p_test_id uuid,
  p_student_id uuid,
  p_approve boolean
)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_t public.instant_tests%ROWTYPE;
  v_pt public.instant_test_participants%ROWTYPE;
BEGIN
  SELECT * INTO v_t FROM public.instant_tests WHERE id = p_test_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'not_found';
  END IF;

  IF NOT (is_course_faculty(v_t.course_id) OR is_super_admin()) THEN
    RAISE EXCEPTION 'forbidden';
  END IF;

  SELECT * INTO v_pt
  FROM public.instant_test_participants
  WHERE test_id = p_test_id AND student_id = p_student_id;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'not_found';
  END IF;

  IF p_approve THEN
    UPDATE public.instant_test_participants
    SET approval_status = 'approved',
        attendance_status = CASE WHEN v_t.status = 'active' THEN 'present' ELSE attendance_status END,
        approved_by = me(),
        approved_at = now()
    WHERE id = v_pt.id;

    PERFORM public.notify(
      p_student_id,
      'instant_join_approved',
      'Approved to join: ' || v_t.topic,
      'Your join request for coding test "' || v_t.topic || '" (code ' || v_t.test_code || ') was approved by faculty.',
      '/app/student',
      v_t.institution_id
    );
  ELSE
    UPDATE public.instant_test_participants
    SET approval_status = 'rejected',
        approved_by = me(),
        approved_at = now()
    WHERE id = v_pt.id;

    PERFORM public.notify(
      p_student_id,
      'instant_join_declined',
      'Join request declined: ' || v_t.topic,
      'Your join request for coding test "' || v_t.topic || '" was declined by faculty.',
      '/app/student',
      v_t.institution_id
    );
  END IF;

  PERFORM public.audit(
    CASE WHEN p_approve THEN 'approve_instant_join_request' ELSE 'reject_instant_join_request' END,
    'instant_test',
    v_t.id::text,
    jsonb_build_object('student_id', p_student_id),
    v_t.institution_id
  );
END;
$$;
