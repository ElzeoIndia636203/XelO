-- Phase 3: Deterministic text similarity, session activation, pick 2, banks, hidden counts, and authorize_run

CREATE OR REPLACE FUNCTION token_similarity(p_a text, p_b text)
RETURNS numeric
LANGUAGE sql
IMMUTABLE
AS $$
  WITH norm AS (
    SELECT
      regexp_split_to_array(
        trim(regexp_replace(lower(coalesce(p_a, '')), '[^a-z0-9]+', ' ', 'g')),
        '\s+'
      ) AS a_arr,
      regexp_split_to_array(
        trim(regexp_replace(lower(coalesce(p_b, '')), '[^a-z0-9]+', ' ', 'g')),
        '\s+'
      ) AS b_arr
  ),
  tok_a AS (
    SELECT DISTINCT tok FROM norm, unnest(a_arr) AS tok WHERE tok <> ''
  ),
  tok_b AS (
    SELECT DISTINCT tok FROM norm, unnest(b_arr) AS tok WHERE tok <> ''
  ),
  inter AS (
    SELECT count(*)::numeric AS n FROM tok_a JOIN tok_b USING (tok)
  ),
  uni AS (
    SELECT count(*)::numeric AS n FROM (SELECT tok FROM tok_a UNION SELECT tok FROM tok_b) u
  )
  SELECT CASE
    WHEN (SELECT n FROM uni) = 0 THEN 0::numeric
    ELSE (SELECT n FROM inter) / (SELECT n FROM uni)
  END;
$$;

CREATE OR REPLACE FUNCTION refresh_session_status(p_session_id uuid)
RETURNS session_status
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_sess public.sessions%ROWTYPE;
  v_picked_valid integer := 0;
  v_pre_e integer := 0;
  v_pre_m integer := 0;
  v_pre_h integer := 0;
  v_post_e integer := 0;
  v_post_m integer := 0;
  v_post_h integer := 0;
  v_has_content boolean := false;
  v_next session_status;
BEGIN
  SELECT * INTO v_sess FROM public.sessions WHERE id = p_session_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'not_found';
  END IF;

  IF v_sess.status = 'conducted' THEN
    RETURN 'conducted';
  END IF;

  SELECT count(*)::integer INTO v_picked_valid
  FROM public.session_questions sq
  JOIN public.questions q ON q.id = sq.question_id
  WHERE sq.session_id = p_session_id
    AND q.status = 'approved'
    AND q.valid IS TRUE;

  SELECT
    count(*) FILTER (WHERE bank = 'pre' AND level = 'easy' AND approved)::integer,
    count(*) FILTER (WHERE bank = 'pre' AND level = 'medium' AND approved)::integer,
    count(*) FILTER (WHERE bank = 'pre' AND level = 'hard' AND approved)::integer,
    count(*) FILTER (WHERE bank = 'post' AND level = 'easy' AND approved)::integer,
    count(*) FILTER (WHERE bank = 'post' AND level = 'medium' AND approved)::integer,
    count(*) FILTER (WHERE bank = 'post' AND level = 'hard' AND approved)::integer
  INTO v_pre_e, v_pre_m, v_pre_h, v_post_e, v_post_m, v_post_h
  FROM public.bank_items
  WHERE session_id = p_session_id;

  IF v_picked_valid = 2
     AND v_pre_e = 15 AND v_pre_m = 15 AND v_pre_h = 15
     AND v_post_e = 15 AND v_post_m = 15 AND v_post_h = 15 THEN
    v_next := 'active';
  ELSE
    SELECT EXISTS (SELECT 1 FROM public.questions WHERE session_id = p_session_id)
        OR EXISTS (SELECT 1 FROM public.bank_items WHERE session_id = p_session_id)
    INTO v_has_content;

    IF v_sess.status = 'none' AND NOT v_has_content THEN
      v_next := 'none';
    ELSE
      v_next := 'draft';
    END IF;
  END IF;

  IF v_next IS DISTINCT FROM v_sess.status THEN
    UPDATE public.sessions SET status = v_next WHERE id = p_session_id;
  END IF;

  RETURN v_next;
END;
$$;

REVOKE ALL ON FUNCTION public.refresh_session_status(uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.refresh_session_status(uuid) TO service_role;

CREATE OR REPLACE FUNCTION pick_session_questions(
  p_session_id uuid,
  p_q1 uuid,
  p_q2 uuid
)
RETURNS session_status
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_sess public.sessions%ROWTYPE;
  v_course public.courses%ROWTYPE;
  v_q1 public.questions%ROWTYPE;
  v_q2 public.questions%ROWTYPE;
  v_status session_status;
BEGIN
  SELECT * INTO v_sess FROM public.sessions WHERE id = p_session_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'not_found';
  END IF;

  IF NOT is_course_faculty(v_sess.course_id) THEN
    RAISE EXCEPTION 'forbidden';
  END IF;

  SELECT * INTO v_course FROM public.courses WHERE id = v_sess.course_id;
  IF v_course.plan_status <> 'approved' THEN
    RAISE EXCEPTION 'not_editable';
  END IF;

  IF p_q1 IS NULL OR p_q2 IS NULL OR p_q1 = p_q2 THEN
    RAISE EXCEPTION 'invalid_input';
  END IF;

  SELECT * INTO v_q1 FROM public.questions WHERE id = p_q1 AND course_id = v_course.id;
  SELECT * INTO v_q2 FROM public.questions WHERE id = p_q2 AND course_id = v_course.id;
  IF v_q1.id IS NULL OR v_q2.id IS NULL THEN
    RAISE EXCEPTION 'not_found';
  END IF;

  IF v_q1.session_id IS DISTINCT FROM p_session_id OR v_q2.session_id IS DISTINCT FROM p_session_id THEN
    RAISE EXCEPTION 'invalid_input';
  END IF;

  IF v_q1.valid IS NOT TRUE OR v_q2.valid IS NOT TRUE THEN
    RAISE EXCEPTION 'question_not_valid';
  END IF;

  DELETE FROM public.session_questions WHERE session_id = p_session_id;

  UPDATE public.questions
  SET status = 'candidate'
  WHERE session_id = p_session_id
    AND status = 'approved'
    AND id NOT IN (p_q1, p_q2);

  UPDATE public.questions
  SET status = 'approved'
  WHERE id IN (p_q1, p_q2);

  INSERT INTO public.session_questions (institution_id, session_id, slot, question_id)
  VALUES
    (v_course.institution_id, p_session_id, 1, p_q1),
    (v_course.institution_id, p_session_id, 2, p_q2);

  v_status := public.refresh_session_status(p_session_id);

  PERFORM public.audit(
    'pick_session_questions',
    'session',
    p_session_id::text,
    jsonb_build_object('q1', p_q1, 'q2', p_q2, 'status', v_status::text),
    v_course.institution_id
  );

  RETURN v_status;
END;
$$;

CREATE OR REPLACE FUNCTION save_own_question(
  p_session_id uuid,
  p_question jsonb
)
RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_sess public.sessions%ROWTYPE;
  v_course public.courses%ROWTYPE;
  v_qid uuid;
  v_title text := trim(coalesce(p_question->>'title', ''));
  v_stmt text := trim(coalesce(p_question->>'statement', ''));
  v_in text := coalesce(p_question->>'input_spec', '');
  v_out text := coalesce(p_question->>'output_spec', '');
  v_cons text := coalesce(p_question->>'constraints', '');
  v_co text := coalesce(NULLIF(trim(coalesce(p_question->>'co_code', '')), ''), 'CO1');
  v_diff text := coalesce(NULLIF(trim(coalesce(p_question->>'difficulty', '')), ''), 'medium');
  v_vis jsonb := coalesce(p_question->'visible_tests', '[]'::jsonb);
  v_hid jsonb := coalesce(p_question->'hidden_tests', '[]'::jsonb);
  v_refs jsonb := coalesce(p_question->'references', '{}'::jsonb);
  v_ord integer := 0;
  v_tc jsonb;
  v_lang text;
  v_code text;
  v_ref_count integer := 0;
BEGIN
  SELECT * INTO v_sess FROM public.sessions WHERE id = p_session_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'not_found';
  END IF;

  IF NOT is_course_faculty(v_sess.course_id) THEN
    RAISE EXCEPTION 'forbidden';
  END IF;

  SELECT * INTO v_course FROM public.courses WHERE id = v_sess.course_id;
  IF v_course.plan_status <> 'approved' THEN
    RAISE EXCEPTION 'not_editable';
  END IF;

  IF v_title = '' OR v_stmt = '' OR v_diff NOT IN ('easy', 'medium', 'hard') THEN
    RAISE EXCEPTION 'invalid_input';
  END IF;

  IF jsonb_typeof(v_vis) <> 'array' OR jsonb_array_length(v_vis) <> 2
     OR jsonb_typeof(v_hid) <> 'array' OR jsonb_array_length(v_hid) <> 3
     OR jsonb_typeof(v_refs) <> 'object' THEN
    RAISE EXCEPTION 'invalid_input';
  END IF;

  INSERT INTO public.questions (
    institution_id, course_id, kind, session_id, co_code, difficulty,
    title, statement, input_spec, output_spec, constraints,
    status, source, valid, created_by
  )
  VALUES (
    v_course.institution_id, v_course.id, 'lab', p_session_id, v_co, v_diff::question_difficulty,
    v_title, v_stmt, v_in, v_out, v_cons,
    'candidate', 'faculty', NULL, auth.uid()
  )
  RETURNING id INTO v_qid;

  FOR v_tc IN SELECT value FROM jsonb_array_elements(v_vis)
  LOOP
    v_ord := v_ord + 1;
    INSERT INTO public.test_cases (institution_id, question_id, ord, input, expected, hidden, marks)
    VALUES (
      v_course.institution_id, v_qid, v_ord,
      coalesce(v_tc->>'input', ''), coalesce(v_tc->>'expected', ''), false, 5
    );
  END LOOP;

  FOR v_tc IN SELECT value FROM jsonb_array_elements(v_hid)
  LOOP
    v_ord := v_ord + 1;
    INSERT INTO public.test_cases (institution_id, question_id, ord, input, expected, hidden, marks)
    VALUES (
      v_course.institution_id, v_qid, v_ord,
      coalesce(v_tc->>'input', ''), coalesce(v_tc->>'expected', ''), true, 5
    );
  END LOOP;

  FOR v_lang, v_code IN SELECT key, value FROM jsonb_each_text(v_refs)
  LOOP
    IF v_lang IN ('c', 'cpp', 'java', 'python', 'rust', 'go') AND length(trim(v_code)) > 0 THEN
      INSERT INTO public.reference_solutions (institution_id, question_id, lang, code)
      VALUES (v_course.institution_id, v_qid, v_lang, v_code);
      v_ref_count := v_ref_count + 1;
    END IF;
  END LOOP;

  IF v_ref_count = 0 THEN
    RAISE EXCEPTION 'invalid_input';
  END IF;

  PERFORM public.refresh_session_status(p_session_id);

  PERFORM public.audit(
    'save_own_question',
    'question',
    v_qid::text,
    jsonb_build_object('session_id', p_session_id, 'title', v_title),
    v_course.institution_id
  );

  RETURN v_qid;
END;
$$;

CREATE OR REPLACE FUNCTION import_lab_questions(
  p_session_id uuid,
  p_items jsonb
)
RETURNS uuid[]
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_item jsonb;
  v_ids uuid[] := ARRAY[]::uuid[];
  v_qid uuid;
BEGIN
  IF jsonb_typeof(p_items) <> 'array' OR jsonb_array_length(p_items) = 0 OR jsonb_array_length(p_items) > 10 THEN
    RAISE EXCEPTION 'invalid_input';
  END IF;

  FOR v_item IN SELECT value FROM jsonb_array_elements(p_items)
  LOOP
    v_qid := public.save_own_question(p_session_id, v_item);
    v_ids := array_append(v_ids, v_qid);
  END LOOP;

  RETURN v_ids;
END;
$$;

CREATE OR REPLACE FUNCTION approve_bank(
  p_session_id uuid,
  p_bank bank_type
)
RETURNS session_status
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_sess public.sessions%ROWTYPE;
  v_course public.courses%ROWTYPE;
  v_other bank_type;
  v_easy integer := 0;
  v_med integer := 0;
  v_hard integer := 0;
  v_overlap boolean := false;
  v_status session_status;
BEGIN
  SELECT * INTO v_sess FROM public.sessions WHERE id = p_session_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'not_found';
  END IF;

  IF NOT is_course_faculty(v_sess.course_id) THEN
    RAISE EXCEPTION 'forbidden';
  END IF;

  SELECT * INTO v_course FROM public.courses WHERE id = v_sess.course_id;
  IF v_course.plan_status <> 'approved' THEN
    RAISE EXCEPTION 'not_editable';
  END IF;

  SELECT
    count(*) FILTER (WHERE level = 'easy')::integer,
    count(*) FILTER (WHERE level = 'medium')::integer,
    count(*) FILTER (WHERE level = 'hard')::integer
  INTO v_easy, v_med, v_hard
  FROM public.bank_items
  WHERE session_id = p_session_id AND bank = p_bank;

  IF v_easy <> 15 OR v_med <> 15 OR v_hard <> 15 THEN
    RAISE EXCEPTION 'bank_incomplete';
  END IF;

  v_other := CASE WHEN p_bank = 'pre' THEN 'post'::bank_type ELSE 'pre'::bank_type END;

  SELECT EXISTS (
    SELECT 1
    FROM public.bank_items a
    JOIN public.bank_items b
      ON b.session_id = a.session_id AND b.bank = v_other
    WHERE a.session_id = p_session_id
      AND a.bank = p_bank
      AND public.token_similarity(a.stem, b.stem) >= 0.8
  ) INTO v_overlap;

  IF v_overlap THEN
    RAISE EXCEPTION 'bank_overlap';
  END IF;

  UPDATE public.bank_items
  SET approved = true
  WHERE session_id = p_session_id AND bank = p_bank;

  v_status := public.refresh_session_status(p_session_id);

  PERFORM public.audit(
    'approve_bank',
    'session',
    p_session_id::text,
    jsonb_build_object('bank', p_bank::text, 'status', v_status::text),
    v_course.institution_id
  );

  RETURN v_status;
END;
$$;

CREATE OR REPLACE FUNCTION upsert_bank_item(
  p_session_id uuid,
  p_bank bank_type,
  p_level question_difficulty,
  p_stem text,
  p_options jsonb,
  p_answer integer,
  p_item_id uuid DEFAULT NULL
)
RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_sess public.sessions%ROWTYPE;
  v_stem text := trim(coalesce(p_stem, ''));
  v_id uuid;
BEGIN
  SELECT * INTO v_sess FROM public.sessions WHERE id = p_session_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'not_found';
  END IF;

  IF NOT is_course_faculty(v_sess.course_id) THEN
    RAISE EXCEPTION 'forbidden';
  END IF;

  IF v_stem = ''
     OR jsonb_typeof(p_options) <> 'array'
     OR jsonb_array_length(p_options) NOT BETWEEN 2 AND 6
     OR p_answer < 0
     OR p_answer >= jsonb_array_length(p_options) THEN
    RAISE EXCEPTION 'invalid_input';
  END IF;

  IF p_item_id IS NOT NULL THEN
    UPDATE public.bank_items
    SET level = p_level, stem = v_stem, options = p_options, answer = p_answer, approved = false
    WHERE id = p_item_id AND session_id = p_session_id AND bank = p_bank
    RETURNING id INTO v_id;

    IF v_id IS NULL THEN
      RAISE EXCEPTION 'not_found';
    END IF;
  ELSE
    INSERT INTO public.bank_items (institution_id, session_id, bank, level, stem, options, answer, approved)
    VALUES (v_sess.institution_id, p_session_id, p_bank, p_level, v_stem, p_options, p_answer, false)
    RETURNING id INTO v_id;
  END IF;

  UPDATE public.bank_items
  SET approved = false
  WHERE session_id = p_session_id AND bank = p_bank;

  PERFORM public.refresh_session_status(p_session_id);
  RETURN v_id;
END;
$$;

CREATE OR REPLACE FUNCTION delete_bank_item(p_item_id uuid)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_item public.bank_items%ROWTYPE;
  v_course_id uuid;
BEGIN
  SELECT * INTO v_item FROM public.bank_items WHERE id = p_item_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'not_found';
  END IF;

  SELECT course_id INTO v_course_id FROM public.sessions WHERE id = v_item.session_id;
  IF NOT is_course_faculty(v_course_id) THEN
    RAISE EXCEPTION 'forbidden';
  END IF;

  DELETE FROM public.bank_items WHERE id = p_item_id;

  UPDATE public.bank_items
  SET approved = false
  WHERE session_id = v_item.session_id AND bank = v_item.bank;

  PERFORM public.refresh_session_status(v_item.session_id);
END;
$$;

CREATE OR REPLACE FUNCTION import_bank_items(
  p_session_id uuid,
  p_items jsonb
)
RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_sess public.sessions%ROWTYPE;
  v_course public.courses%ROWTYPE;
  v_row jsonb;
  v_count integer := 0;
  v_has_pre boolean := false;
  v_has_post boolean := false;
  v_bank text;
  v_level text;
  v_stem text;
  v_opts jsonb;
  v_ans integer;
BEGIN
  SELECT * INTO v_sess FROM public.sessions WHERE id = p_session_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'not_found';
  END IF;

  IF NOT is_course_faculty(v_sess.course_id) THEN
    RAISE EXCEPTION 'forbidden';
  END IF;

  SELECT * INTO v_course FROM public.courses WHERE id = v_sess.course_id;
  IF v_course.plan_status <> 'approved' THEN
    RAISE EXCEPTION 'not_editable';
  END IF;

  IF jsonb_typeof(p_items) <> 'array' OR jsonb_array_length(p_items) = 0 THEN
    RAISE EXCEPTION 'invalid_input';
  END IF;

  FOR v_row IN SELECT value FROM jsonb_array_elements(p_items)
  LOOP
    v_bank := lower(trim(coalesce(v_row->>'bank', '')));
    v_level := lower(trim(coalesce(v_row->>'level', '')));
    v_stem := trim(coalesce(v_row->>'stem', ''));
    v_opts := v_row->'options';
    v_ans := (v_row->>'answer')::integer;

    IF v_bank NOT IN ('pre', 'post')
       OR v_level NOT IN ('easy', 'medium', 'hard')
       OR v_stem = ''
       OR jsonb_typeof(v_opts) <> 'array'
       OR jsonb_array_length(v_opts) NOT BETWEEN 2 AND 6
       OR v_ans < 0
       OR v_ans >= jsonb_array_length(v_opts) THEN
      RAISE EXCEPTION 'invalid_input';
    END IF;

    IF v_bank = 'pre' THEN v_has_pre := true; END IF;
    IF v_bank = 'post' THEN v_has_post := true; END IF;
  END LOOP;

  IF v_has_pre THEN
    DELETE FROM public.bank_items WHERE session_id = p_session_id AND bank = 'pre';
  END IF;
  IF v_has_post THEN
    DELETE FROM public.bank_items WHERE session_id = p_session_id AND bank = 'post';
  END IF;

  FOR v_row IN SELECT value FROM jsonb_array_elements(p_items)
  LOOP
    INSERT INTO public.bank_items (institution_id, session_id, bank, level, stem, options, answer, approved)
    VALUES (
      v_sess.institution_id,
      p_session_id,
      (lower(trim(v_row->>'bank')))::bank_type,
      (lower(trim(v_row->>'level')))::question_difficulty,
      trim(v_row->>'stem'),
      v_row->'options',
      (v_row->>'answer')::integer,
      false
    );
    v_count := v_count + 1;
  END LOOP;

  PERFORM public.refresh_session_status(p_session_id);

  PERFORM public.audit(
    'import_bank_items',
    'session',
    p_session_id::text,
    jsonb_build_object('count', v_count),
    v_sess.institution_id
  );

  RETURN v_count;
END;
$$;

CREATE OR REPLACE FUNCTION hidden_test_counts(p_question_ids uuid[])
RETURNS TABLE (
  question_id uuid,
  visible_count integer,
  hidden_count integer
)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT
    q.id AS question_id,
    count(tc.id) FILTER (WHERE NOT tc.hidden)::integer AS visible_count,
    count(tc.id) FILTER (WHERE tc.hidden)::integer AS hidden_count
  FROM public.questions q
  LEFT JOIN public.test_cases tc ON tc.question_id = q.id
  WHERE q.id = ANY(coalesce(p_question_ids, ARRAY[]::uuid[]))
    AND (
      is_course_faculty(q.course_id)
      OR can_oversee_course(q.course_id)
      OR student_can_see_question(q.id)
    )
  GROUP BY q.id;
$$;

CREATE OR REPLACE FUNCTION authorize_run(
  p_user_id uuid,
  p_question_id uuid,
  p_context run_context,
  p_mode run_mode DEFAULT 'run',
  p_paper_id uuid DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_prof public.profiles%ROWTYPE;
  v_q public.questions%ROWTYPE;
  v_course public.courses%ROWTYPE;
  v_sess public.sessions%ROWTYPE;
  v_batch_id uuid;
  v_run_id uuid;
  v_att_state text;
  v_vis jsonb;
  v_hid jsonb;
BEGIN
  IF p_user_id IS NULL OR p_question_id IS NULL THEN
    RAISE EXCEPTION 'forbidden';
  END IF;

  SELECT * INTO v_prof FROM public.profiles WHERE id = p_user_id AND active = true;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'forbidden';
  END IF;

  SELECT * INTO v_q FROM public.questions WHERE id = p_question_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'not_found';
  END IF;

  SELECT * INTO v_course FROM public.courses WHERE id = v_q.course_id;

  IF p_context = 'lab' THEN
    IF v_course.faculty_id = p_user_id THEN
      -- Course faculty may run/preview their own questions
      NULL;
    ELSIF v_prof.role = 'student' THEN
      SELECT e.batch_id INTO v_batch_id
      FROM public.enrollments e
      WHERE e.course_id = v_q.course_id AND e.student_id = p_user_id;

      IF v_batch_id IS NULL THEN
        RAISE EXCEPTION 'forbidden';
      END IF;

      SELECT s.* INTO v_sess
      FROM public.session_questions sq
      JOIN public.sessions s ON s.id = sq.session_id
      WHERE sq.question_id = v_q.id
        AND s.status IN ('active', 'conducted')
      LIMIT 1;

      IF v_sess.id IS NULL THEN
        RAISE EXCEPTION 'forbidden';
      END IF;

      IF p_mode = 'submit' THEN
        IF to_regclass('public.session_runs') IS NULL OR to_regclass('public.attendance') IS NULL THEN
          RAISE EXCEPTION 'session_not_open';
        END IF;

        EXECUTE
          'SELECT sr.id, a.state::text
           FROM public.session_runs sr
           JOIN public.attendance a ON a.session_run_id = sr.id AND a.student_id = $1
           WHERE sr.session_id = $2
             AND sr.batch_id = $3
             AND sr.started_at IS NOT NULL
             AND sr.ended_at IS NULL
           LIMIT 1'
        INTO v_run_id, v_att_state
        USING p_user_id, v_sess.id, v_batch_id;

        IF v_run_id IS NULL OR v_att_state NOT IN ('present', 'late') THEN
          RAISE EXCEPTION 'session_not_open';
        END IF;
      END IF;
    ELSE
      RAISE EXCEPTION 'forbidden';
    END IF;
  ELSIF p_context = 'exam' THEN
    IF p_paper_id IS NULL OR to_regclass('public.exam_papers') IS NULL THEN
      RAISE EXCEPTION 'forbidden';
    END IF;
    -- Extended cleanly in Phase 7 when exam_papers exists
    RAISE EXCEPTION 'forbidden';
  ELSE
    RAISE EXCEPTION 'invalid_input';
  END IF;

  SELECT coalesce(
    jsonb_agg(
      jsonb_build_object('ord', ord, 'input', input, 'expected', expected, 'marks', marks)
      ORDER BY ord
    ),
    '[]'::jsonb
  )
  INTO v_vis
  FROM public.test_cases
  WHERE question_id = p_question_id AND hidden = false;

  SELECT coalesce(
    jsonb_agg(
      jsonb_build_object('ord', ord, 'input', input, 'expected', expected, 'marks', marks)
      ORDER BY ord
    ),
    '[]'::jsonb
  )
  INTO v_hid
  FROM public.test_cases
  WHERE question_id = p_question_id AND hidden = true;

  RETURN jsonb_build_object(
    'institution_id', v_course.institution_id,
    'course_id', v_course.id,
    'session_id', v_q.session_id,
    'session_run_id', v_run_id,
    'allowed_langs', to_jsonb(v_course.allowed_langs),
    'visible_tests', v_vis,
    'hidden_tests', v_hid
  );
END;
$$;

REVOKE ALL ON FUNCTION public.authorize_run(uuid, uuid, run_context, run_mode, uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.authorize_run(uuid, uuid, run_context, run_mode, uuid) TO service_role;

GRANT EXECUTE ON FUNCTION
  pick_session_questions(uuid, uuid, uuid),
  save_own_question(uuid, jsonb),
  import_lab_questions(uuid, jsonb),
  approve_bank(uuid, bank_type),
  upsert_bank_item(uuid, bank_type, question_difficulty, text, jsonb, integer, uuid),
  delete_bank_item(uuid),
  import_bank_items(uuid, jsonb),
  hidden_test_counts(uuid[])
TO authenticated;

CREATE OR REPLACE FUNCTION handle_api_bank_mutation(
  p_session_id uuid,
  p_bank bank_type
)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  IF is_course_faculty((SELECT course_id FROM public.sessions WHERE id = p_session_id)) THEN
    UPDATE public.bank_items
    SET approved = false
    WHERE session_id = p_session_id AND bank = p_bank AND approved = true;

    PERFORM public.refresh_session_status(p_session_id);
  END IF;
END;
$$;

REVOKE ALL ON FUNCTION public.handle_api_bank_mutation(uuid, bank_type) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.handle_api_bank_mutation(uuid, bank_type) TO authenticated;

CREATE OR REPLACE FUNCTION on_bank_items_api_changed()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  v_sid uuid := COALESCE(NEW.session_id, OLD.session_id);
  v_bank bank_type := COALESCE(NEW.bank, OLD.bank);
BEGIN
  IF pg_trigger_depth() > 1 OR NOT is_api_user() THEN
    RETURN NULL;
  END IF;

  PERFORM public.handle_api_bank_mutation(v_sid, v_bank);
  RETURN NULL;
END;
$$;

CREATE TRIGGER trg_bank_items_api_changed
  AFTER INSERT OR UPDATE OR DELETE ON bank_items
  FOR EACH ROW
  EXECUTE FUNCTION on_bank_items_api_changed();

