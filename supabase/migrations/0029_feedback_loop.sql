-- Post-CO Feedback Loop: course/CO progression, HOD-launched 5->1 rating surveys,
-- mandatory student portal gate, due extension/closure, and Faculty+Dean sharing.

CREATE TABLE feedback_loops (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  institution_id uuid NOT NULL REFERENCES institutions(id) ON DELETE CASCADE,
  department_id uuid NOT NULL REFERENCES departments(id) ON DELETE CASCADE,
  course_id uuid NOT NULL REFERENCES courses(id) ON DELETE CASCADE,
  co_id uuid REFERENCES course_outcomes(id) ON DELETE SET NULL,
  co_code text NOT NULL,
  co_statement text NOT NULL DEFAULT '',
  title text NOT NULL,
  status text NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'closed')),
  due_at timestamptz NOT NULL,
  questions jsonb NOT NULL DEFAULT '[]'::jsonb,
  hod_remarks text NOT NULL DEFAULT '',
  shared_at timestamptz,
  created_by uuid REFERENCES profiles(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE feedback_responses (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  loop_id uuid NOT NULL REFERENCES feedback_loops(id) ON DELETE CASCADE,
  institution_id uuid NOT NULL REFERENCES institutions(id) ON DELETE CASCADE,
  course_id uuid NOT NULL REFERENCES courses(id) ON DELETE CASCADE,
  student_id uuid NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
  answers jsonb NOT NULL DEFAULT '{}'::jsonb,
  comment text NOT NULL DEFAULT '',
  submitted_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (loop_id, student_id)
);

CREATE INDEX idx_feedback_loops_dept ON feedback_loops(department_id, created_at DESC);
CREATE INDEX idx_feedback_loops_course ON feedback_loops(course_id, status);
CREATE INDEX idx_feedback_responses_loop ON feedback_responses(loop_id);
CREATE INDEX idx_feedback_responses_student ON feedback_responses(student_id);

ALTER TABLE feedback_loops ENABLE ROW LEVEL SECURITY;
ALTER TABLE feedback_responses ENABLE ROW LEVEL SECURITY;

GRANT SELECT ON feedback_loops TO authenticated;
GRANT SELECT, INSERT ON feedback_responses TO authenticated;
GRANT ALL ON feedback_loops, feedback_responses TO service_role;

CREATE POLICY feedback_loops_read ON feedback_loops
  FOR SELECT TO authenticated
  USING (
    has_role('super_admin')
    OR (
      institution_id = my_institution()
      AND (
        has_role('hod') OR has_role('dean') OR has_role('coe') OR has_role('vc')
        OR is_course_faculty(course_id)
        OR is_course_student(course_id)
      )
    )
  );

CREATE POLICY feedback_responses_read ON feedback_responses
  FOR SELECT TO authenticated
  USING (
    student_id = auth.uid()
    OR has_role('super_admin')
    OR (
      institution_id = my_institution()
      AND (
        has_role('hod') OR has_role('dean') OR has_role('coe') OR has_role('vc')
        OR is_course_faculty(course_id)
      )
    )
  );

CREATE POLICY feedback_responses_insert ON feedback_responses
  FOR INSERT TO authenticated
  WITH CHECK (
    student_id = auth.uid()
    AND is_course_student(course_id)
  );

CREATE OR REPLACE FUNCTION hod_co_progression(p_department_id uuid DEFAULT NULL)
RETURNS TABLE (
  course_id uuid,
  course_code text,
  course_title text,
  faculty_id uuid,
  faculty_name text,
  co_id uuid,
  co_code text,
  co_statement text,
  total_sessions integer,
  conducted_sessions integer,
  co_completed boolean,
  enrolled_students integer,
  existing_loop_id uuid,
  loop_status text,
  loop_due_at timestamptz,
  response_count integer
)
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_me public.profiles%ROWTYPE;
  v_dept uuid;
BEGIN
  SELECT * INTO v_me FROM public.profiles WHERE id = auth.uid() AND active = true;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'forbidden';
  END IF;

  IF NOT (
    public.has_role('hod')
    OR public.has_role('dean')
    OR public.has_role('coe')
    OR public.has_role('vc')
    OR public.has_role('super_admin')
  ) THEN
    RAISE EXCEPTION 'forbidden';
  END IF;

  v_dept := coalesce(p_department_id, v_me.department_id);
  IF v_dept IS NULL THEN
    RETURN;
  END IF;

  RETURN QUERY
  SELECT
    c.id AS course_id,
    c.code AS course_code,
    c.title AS course_title,
    c.faculty_id,
    coalesce(f.full_name, f.email, 'Unassigned') AS faculty_name,
    co.id AS co_id,
    co.code AS co_code,
    co.statement AS co_statement,
    (SELECT count(*)::integer FROM public.sessions s WHERE s.course_id = c.id AND s.co_id = co.id) AS total_sessions,
    (SELECT count(*)::integer FROM public.sessions s WHERE s.course_id = c.id AND s.co_id = co.id AND s.status = 'conducted') AS conducted_sessions,
    (
      (SELECT count(*) FROM public.sessions s WHERE s.course_id = c.id AND s.co_id = co.id) > 0
      AND (SELECT count(*) FROM public.sessions s WHERE s.course_id = c.id AND s.co_id = co.id AND s.status = 'conducted')
          = (SELECT count(*) FROM public.sessions s WHERE s.course_id = c.id AND s.co_id = co.id)
    ) AS co_completed,
    (SELECT count(*)::integer FROM public.enrollments e WHERE e.course_id = c.id) AS enrolled_students,
    fl.id AS existing_loop_id,
    fl.status AS loop_status,
    fl.due_at AS loop_due_at,
    (SELECT count(*)::integer FROM public.feedback_responses fr WHERE fr.loop_id = fl.id) AS response_count
  FROM public.courses c
  JOIN public.course_outcomes co ON co.course_id = c.id
  LEFT JOIN public.profiles f ON f.id = c.faculty_id
  LEFT JOIN LATERAL (
    SELECT fl1.id, fl1.status, fl1.due_at
    FROM public.feedback_loops fl1
    WHERE fl1.course_id = c.id AND (fl1.co_id = co.id OR fl1.co_code = co.code)
    ORDER BY fl1.created_at DESC
    LIMIT 1
  ) fl ON true
  WHERE c.department_id = v_dept
    AND (public.has_role('super_admin') OR c.institution_id = v_me.institution_id)
  ORDER BY c.code, co.code;
END;
$$;

CREATE OR REPLACE FUNCTION hod_launch_feedback_loop(
  p_course_id uuid,
  p_co_id uuid,
  p_co_code text,
  p_co_statement text,
  p_title text,
  p_due_at timestamptz,
  p_questions jsonb
)
RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_me public.profiles%ROWTYPE;
  v_course public.courses%ROWTYPE;
  v_loop_id uuid;
  v_stu record;
BEGIN
  SELECT * INTO v_me FROM public.profiles WHERE id = auth.uid() AND active = true;
  IF NOT FOUND OR NOT (public.has_role('hod') OR public.has_role('super_admin')) THEN
    RAISE EXCEPTION 'forbidden';
  END IF;

  SELECT * INTO v_course FROM public.courses WHERE id = p_course_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'not_found';
  END IF;

  IF NOT public.has_role('super_admin') AND (
    v_course.institution_id <> v_me.institution_id
    OR v_course.department_id <> v_me.department_id
  ) THEN
    RAISE EXCEPTION 'forbidden';
  END IF;

  IF jsonb_typeof(p_questions) <> 'array' OR jsonb_array_length(p_questions) = 0 THEN
    RAISE EXCEPTION 'invalid_input';
  END IF;

  INSERT INTO public.feedback_loops (
    institution_id, department_id, course_id, co_id, co_code, co_statement,
    title, status, due_at, questions, created_by
  ) VALUES (
    v_course.institution_id,
    v_course.department_id,
    v_course.id,
    p_co_id,
    trim(p_co_code),
    trim(coalesce(p_co_statement, '')),
    trim(p_title),
    'open',
    coalesce(p_due_at, now() + interval '3 days'),
    p_questions,
    v_me.id
  )
  RETURNING id INTO v_loop_id;

  FOR v_stu IN
    SELECT e.student_id FROM public.enrollments e WHERE e.course_id = v_course.id
  LOOP
    PERFORM public.notify(
      v_stu.student_id,
      'feedback_loop',
      'Course feedback requested: ' || v_course.code || ' ' || trim(p_co_code),
      trim(p_title),
      '/student',
      v_course.institution_id
    );
  END LOOP;

  INSERT INTO public.audit_log (
    institution_id, actor_id, action, entity_type, entity_id, details
  ) VALUES (
    v_course.institution_id,
    v_me.id,
    'hod_launch_feedback_loop',
    'feedback_loop',
    v_loop_id,
    jsonb_build_object('course_id', v_course.id, 'co_code', p_co_code, 'question_count', jsonb_array_length(p_questions))
  );

  RETURN v_loop_id;
END;
$$;

CREATE OR REPLACE FUNCTION hod_update_feedback_due(
  p_loop_id uuid,
  p_due_at timestamptz
)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_me public.profiles%ROWTYPE;
  v_loop public.feedback_loops%ROWTYPE;
BEGIN
  SELECT * INTO v_me FROM public.profiles WHERE id = auth.uid() AND active = true;
  IF NOT FOUND OR NOT (public.has_role('hod') OR public.has_role('super_admin')) THEN
    RAISE EXCEPTION 'forbidden';
  END IF;

  SELECT * INTO v_loop FROM public.feedback_loops WHERE id = p_loop_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'not_found';
  END IF;

  IF NOT public.has_role('super_admin') AND (
    v_loop.institution_id <> v_me.institution_id
    OR v_loop.department_id <> v_me.department_id
  ) THEN
    RAISE EXCEPTION 'forbidden';
  END IF;

  UPDATE public.feedback_loops
  SET due_at = p_due_at, status = 'open', updated_at = now()
  WHERE id = p_loop_id;

  INSERT INTO public.audit_log (
    institution_id, actor_id, action, entity_type, entity_id, details
  ) VALUES (
    v_loop.institution_id, v_me.id, 'hod_extend_feedback_loop', 'feedback_loop', p_loop_id,
    jsonb_build_object('due_at', p_due_at)
  );
END;
$$;

CREATE OR REPLACE FUNCTION hod_close_and_share_feedback(
  p_loop_id uuid,
  p_hod_remarks text
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_me public.profiles%ROWTYPE;
  v_loop public.feedback_loops%ROWTYPE;
  v_course public.courses%ROWTYPE;
  v_remarks text := trim(coalesce(p_hod_remarks, ''));
  v_resp_count integer := 0;
  v_dept_school text;
  v_dean record;
BEGIN
  SELECT * INTO v_me FROM public.profiles WHERE id = auth.uid() AND active = true;
  IF NOT FOUND OR NOT (public.has_role('hod') OR public.has_role('super_admin')) THEN
    RAISE EXCEPTION 'forbidden';
  END IF;

  SELECT * INTO v_loop FROM public.feedback_loops WHERE id = p_loop_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'not_found';
  END IF;

  IF NOT public.has_role('super_admin') AND (
    v_loop.institution_id <> v_me.institution_id
    OR v_loop.department_id <> v_me.department_id
  ) THEN
    RAISE EXCEPTION 'forbidden';
  END IF;

  IF v_remarks = '' THEN
    RAISE EXCEPTION 'remark_required';
  END IF;

  SELECT * INTO v_course FROM public.courses WHERE id = v_loop.course_id;
  SELECT count(*)::integer INTO v_resp_count FROM public.feedback_responses WHERE loop_id = p_loop_id;

  UPDATE public.feedback_loops
  SET status = 'closed',
      hod_remarks = v_remarks,
      shared_at = now(),
      updated_at = now()
  WHERE id = p_loop_id;

  IF v_course.faculty_id IS NOT NULL THEN
    PERFORM public.notify(
      v_course.faculty_id,
      'feedback_shared',
      'Feedback insights shared: ' || v_course.code || ' ' || v_loop.co_code,
      'Responses: ' || v_resp_count::text || ' · HoD remarks: ' || v_remarks,
      '/faculty',
      v_loop.institution_id
    );
  END IF;

  SELECT school INTO v_dept_school FROM public.departments WHERE id = v_loop.department_id;
  FOR v_dean IN
    SELECT p.id
    FROM public.profiles p
    WHERE p.institution_id = v_loop.institution_id
      AND p.active = true
      AND 'dean' = ANY(coalesce(p.roles, ARRAY[p.role]))
      AND (v_dept_school IS NULL OR p.school IS NULL OR p.school = '' OR p.school = v_dept_school)
  LOOP
    PERFORM public.notify(
      v_dean.id,
      'feedback_shared',
      'HoD closed & shared CO feedback: ' || v_course.code || ' ' || v_loop.co_code,
      'Responses: ' || v_resp_count::text || ' · HoD remarks: ' || v_remarks,
      '/oversight',
      v_loop.institution_id
    );
  END LOOP;

  INSERT INTO public.audit_log (
    institution_id, actor_id, action, entity_type, entity_id, details
  ) VALUES (
    v_loop.institution_id, v_me.id, 'hod_close_share_feedback_loop', 'feedback_loop', p_loop_id,
    jsonb_build_object('responses', v_resp_count, 'remarks', v_remarks)
  );

  RETURN jsonb_build_object('responses', v_resp_count, 'shared_at', now());
END;
$$;

CREATE OR REPLACE FUNCTION student_pending_feedback_loops()
RETURNS TABLE (
  id uuid,
  course_id uuid,
  course_code text,
  course_title text,
  co_code text,
  co_statement text,
  title text,
  due_at timestamptz,
  questions jsonb
)
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  RETURN QUERY
  SELECT
    fl.id,
    fl.course_id,
    c.code AS course_code,
    c.title AS course_title,
    fl.co_code,
    fl.co_statement,
    fl.title,
    fl.due_at,
    fl.questions
  FROM public.feedback_loops fl
  JOIN public.courses c ON c.id = fl.course_id
  JOIN public.enrollments e ON e.course_id = fl.course_id AND e.student_id = auth.uid()
  WHERE fl.status = 'open'
    AND NOT EXISTS (
      SELECT 1 FROM public.feedback_responses fr
      WHERE fr.loop_id = fl.id AND fr.student_id = auth.uid()
    )
  ORDER BY fl.due_at ASC, fl.created_at ASC;
END;
$$;

CREATE OR REPLACE FUNCTION student_submit_feedback(
  p_loop_id uuid,
  p_answers jsonb,
  p_comment text DEFAULT ''
)
RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_loop public.feedback_loops%ROWTYPE;
  v_q jsonb;
  v_qid text;
  v_val integer;
  v_resp_id uuid;
BEGIN
  IF auth.uid() IS NULL THEN
    RAISE EXCEPTION 'forbidden';
  END IF;

  SELECT * INTO v_loop FROM public.feedback_loops WHERE id = p_loop_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'not_found';
  END IF;

  IF v_loop.status <> 'open' THEN
    RAISE EXCEPTION 'not_open';
  END IF;

  IF NOT public.is_course_student(v_loop.course_id) THEN
    RAISE EXCEPTION 'forbidden';
  END IF;

  IF jsonb_typeof(p_answers) <> 'object' THEN
    RAISE EXCEPTION 'invalid_input';
  END IF;

  FOR v_q IN SELECT value FROM jsonb_array_elements(v_loop.questions)
  LOOP
    v_qid := v_q->>'id';
    IF NOT (p_answers ? v_qid) THEN
      RAISE EXCEPTION 'invalid_input';
    END IF;
    v_val := (p_answers->>v_qid)::integer;
    IF v_val < 1 OR v_val > 5 THEN
      RAISE EXCEPTION 'invalid_input';
    END IF;
  END LOOP;

  INSERT INTO public.feedback_responses (
    loop_id, institution_id, course_id, student_id, answers, comment
  ) VALUES (
    v_loop.id, v_loop.institution_id, v_loop.course_id, auth.uid(), p_answers, trim(coalesce(p_comment, ''))
  )
  RETURNING id INTO v_resp_id;

  RETURN v_resp_id;
END;
$$;

REVOKE ALL ON FUNCTION hod_co_progression(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION hod_co_progression(uuid) TO authenticated;
REVOKE ALL ON FUNCTION hod_launch_feedback_loop(uuid, uuid, text, text, text, timestamptz, jsonb) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION hod_launch_feedback_loop(uuid, uuid, text, text, text, timestamptz, jsonb) TO authenticated;
REVOKE ALL ON FUNCTION hod_update_feedback_due(uuid, timestamptz) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION hod_update_feedback_due(uuid, timestamptz) TO authenticated;
REVOKE ALL ON FUNCTION hod_close_and_share_feedback(uuid, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION hod_close_and_share_feedback(uuid, text) TO authenticated;
REVOKE ALL ON FUNCTION student_pending_feedback_loops() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION student_pending_feedback_loops() TO authenticated;
REVOKE ALL ON FUNCTION student_submit_feedback(uuid, jsonb, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION student_submit_feedback(uuid, jsonb, text) TO authenticated;
