-- Join-by-code approval workflows for:
-- 1) Class join requests ("Join class using code" on student home -> faculty approves in Batches)
-- 2) Instant coding test join requests ("Join Live Test using code" -> faculty approves in Instant Test)
--    Unapproved students cannot start the test and never appear in performance/mark reports.

CREATE TABLE IF NOT EXISTS public.class_join_requests (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  course_id uuid NOT NULL REFERENCES public.courses(id) ON DELETE CASCADE,
  batch_id uuid NOT NULL REFERENCES public.batches(id) ON DELETE CASCADE,
  institution_id uuid NOT NULL REFERENCES public.institutions(id) ON DELETE CASCADE,
  student_id uuid NOT NULL REFERENCES public.profiles(id) ON DELETE CASCADE,
  status text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'approved', 'rejected')),
  requested_at timestamptz NOT NULL DEFAULT now(),
  reviewed_by uuid REFERENCES public.profiles(id),
  reviewed_at timestamptz,
  UNIQUE (course_id, student_id)
);

CREATE INDEX IF NOT EXISTS idx_class_join_requests_course ON public.class_join_requests(course_id, status);
CREATE INDEX IF NOT EXISTS idx_class_join_requests_student ON public.class_join_requests(student_id);

ALTER TABLE public.class_join_requests ENABLE ROW LEVEL SECURITY;
GRANT SELECT ON public.class_join_requests TO authenticated;
GRANT ALL ON public.class_join_requests TO service_role;

DROP POLICY IF EXISTS class_join_requests_read ON public.class_join_requests;
CREATE POLICY class_join_requests_read ON public.class_join_requests
  FOR SELECT TO authenticated
  USING (student_id = me() OR can_read_course(course_id));

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
      v_batch.institution_id,
      'Class join request: ' || coalesce(v_prof.full_name, v_prof.email),
      coalesce(v_prof.roll_no, v_prof.email) || ' requested to join ' || v_course.code || ' (' || v_batch.name || ') using code ' || v_clean || '.',
      '/faculty/c/' || v_course.id || '/batches'
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

CREATE OR REPLACE FUNCTION student_list_class_join_requests()
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_uid uuid := auth.uid();
  v_rows jsonb := '[]'::jsonb;
BEGIN
  IF v_uid IS NULL THEN
    RAISE EXCEPTION 'forbidden';
  END IF;

  SELECT coalesce(jsonb_agg(
    jsonb_build_object(
      'id', r.id,
      'course_id', r.course_id,
      'course_code', c.code,
      'course_title', c.title,
      'batch_id', r.batch_id,
      'batch_name', b.name,
      'class_code', b.class_code,
      'status', r.status,
      'requested_at', r.requested_at
    ) ORDER BY r.requested_at DESC
  ), '[]'::jsonb)
  INTO v_rows
  FROM public.class_join_requests r
  JOIN public.courses c ON c.id = r.course_id
  JOIN public.batches b ON b.id = r.batch_id
  WHERE r.student_id = v_uid;

  RETURN v_rows;
END;
$$;

CREATE OR REPLACE FUNCTION faculty_list_class_join_requests(p_course_id uuid)
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_rows jsonb := '[]'::jsonb;
BEGIN
  IF NOT (is_course_faculty(p_course_id) OR is_super_admin()) THEN
    RAISE EXCEPTION 'forbidden';
  END IF;

  SELECT coalesce(jsonb_agg(
    jsonb_build_object(
      'id', r.id,
      'course_id', r.course_id,
      'batch_id', r.batch_id,
      'batch_name', b.name,
      'class_code', b.class_code,
      'student_id', r.student_id,
      'student_name', coalesce(p.full_name, p.email),
      'student_email', p.email,
      'roll_no', coalesce(p.roll_no, ''),
      'status', r.status,
      'requested_at', r.requested_at
    ) ORDER BY (r.status = 'pending') DESC, r.requested_at DESC
  ), '[]'::jsonb)
  INTO v_rows
  FROM public.class_join_requests r
  JOIN public.profiles p ON p.id = r.student_id
  JOIN public.batches b ON b.id = r.batch_id
  WHERE r.course_id = p_course_id;

  RETURN v_rows;
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
      v_req.institution_id,
      'Approved: ' || v_course.code,
      'Your request to join ' || v_course.code || ' · ' || v_course.title || ' was approved by faculty.',
      '/student'
    );
  ELSE
    UPDATE public.class_join_requests
    SET status = 'rejected',
        reviewed_by = me(),
        reviewed_at = now()
    WHERE id = v_req.id;

    PERFORM public.notify(
      v_req.student_id,
      v_req.institution_id,
      'Declined: ' || v_course.code,
      'Your request to join ' || v_course.code || ' was declined by faculty.',
      '/student'
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

-- =====================================================================
-- 2. Instant Coding Test Join-by-Code Approval Flow
-- =====================================================================

ALTER TABLE public.instant_test_participants
  ADD COLUMN IF NOT EXISTS approval_status text NOT NULL DEFAULT 'approved' CHECK (approval_status IN ('pending', 'approved', 'rejected')),
  ADD COLUMN IF NOT EXISTS requested_via_code boolean NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS requested_prn text,
  ADD COLUMN IF NOT EXISTS requested_name text,
  ADD COLUMN IF NOT EXISTS requested_at timestamptz,
  ADD COLUMN IF NOT EXISTS approved_by uuid REFERENCES public.profiles(id),
  ADD COLUMN IF NOT EXISTS approved_at timestamptz;

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
      v_t.institution_id,
      'Live test join request: ' || v_name,
      v_prn || ' requested to join "' || v_t.topic || '" using code ' || v_t.test_code || '.',
      '/faculty/c/' || v_t.course_id || '/instant'
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

-- Update legacy student_join_instant_test so code join requires faculty approval too.
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
        v_t.institution_id,
        'Live test join request: ' || v_name,
        v_prn || ' requested to join "' || v_t.topic || '" using code ' || v_t.test_code || '.',
        '/faculty/c/' || v_t.course_id || '/instant'
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

-- Update student_start_course_instant_test to enforce approval_status = 'approved'
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

  INSERT INTO public.instant_test_attempts (
    test_id, institution_id, student_id, prn, student_name
  ) VALUES (
    v_t.id, v_t.institution_id, v_me.id, v_prn, v_name
  )
  ON CONFLICT (test_id, student_id) DO NOTHING;

  SELECT * INTO v_attempt
  FROM public.instant_test_attempts
  WHERE test_id = v_t.id AND student_id = v_me.id;

  RETURN jsonb_build_object(
    'attempt_id', v_attempt.id,
    'test_id', v_t.id
  );
END;
$$;

-- Update student_list_instant_tests to include approval_status
DROP FUNCTION IF EXISTS student_list_instant_tests();
CREATE OR REPLACE FUNCTION student_list_instant_tests()
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_me public.profiles%ROWTYPE;
  v_rows jsonb := '[]'::jsonb;
BEGIN
  SELECT * INTO v_me FROM public.profiles WHERE id = auth.uid() AND active = true;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'forbidden';
  END IF;

  SELECT coalesce(jsonb_agg(
    jsonb_build_object(
      'test_id', t.id,
      'course_id', t.course_id,
      'course_code', c.code,
      'course_title', c.title,
      'test_code', t.test_code,
      'topic', t.topic,
      'status', t.status,
      'active', t.active,
      'scheduled_at', t.scheduled_at,
      'activated_at', t.activated_at,
      'total_marks', t.total_marks,
      'pretest_count', t.pretest_count,
      'pretest_marks', t.pretest_marks,
      'viva_marks', t.viva_marks,
      'attendance_status', coalesce(pt.attendance_status, 'pending'),
      'approval_status', coalesce(pt.approval_status, 'approved'),
      'attempt_id', a.id,
      'submitted_at', a.submitted_at,
      'final_score', a.final_score,
      'marks_approved', coalesce(a.marks_approved, false)
    )
    ORDER BY (t.status = 'active') DESC, coalesce(t.scheduled_at, t.created_at) DESC
  ), '[]'::jsonb)
  INTO v_rows
  FROM public.instant_test_participants pt
  JOIN public.instant_tests t ON t.id = pt.test_id
  JOIN public.courses c ON c.id = t.course_id
  LEFT JOIN public.instant_test_attempts a
    ON a.test_id = t.id AND a.student_id = v_me.id
  WHERE pt.student_id = v_me.id;

  RETURN v_rows;
END;
$$;

-- Faculty approves or declines a student's live test join request
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
      v_t.institution_id,
      'Approved to join: ' || v_t.topic,
      'Your join request for coding test "' || v_t.topic || '" (code ' || v_t.test_code || ') was approved by faculty.',
      '/student'
    );
  ELSE
    UPDATE public.instant_test_participants
    SET approval_status = 'rejected',
        approved_by = me(),
        approved_at = now()
    WHERE id = v_pt.id;

    PERFORM public.notify(
      p_student_id,
      v_t.institution_id,
      'Join request declined: ' || v_t.topic,
      'Your join request for coding test "' || v_t.topic || '" was declined by faculty.',
      '/student'
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

GRANT EXECUTE ON FUNCTION student_request_join_class(text) TO authenticated;
GRANT EXECUTE ON FUNCTION student_list_class_join_requests() TO authenticated;
GRANT EXECUTE ON FUNCTION faculty_list_class_join_requests(uuid) TO authenticated;
GRANT EXECUTE ON FUNCTION faculty_review_class_join_request(uuid, boolean) TO authenticated;
GRANT EXECUTE ON FUNCTION student_request_join_instant_test(text, text, text) TO authenticated;
GRANT EXECUTE ON FUNCTION student_list_instant_tests() TO authenticated;
GRANT EXECUTE ON FUNCTION faculty_review_instant_join_request(uuid, uuid, boolean) TO authenticated;
