-- Phase 2: Course setup, HOD approval, roster import, class code join, and session plan workflows

-- Extend handle_new_user so invited students with pending_enrollments get enrolled on first sign-in
CREATE OR REPLACE FUNCTION handle_new_user()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_email text := lower(trim(coalesce(NEW.email, '')));
  v_domain text := split_part(v_email, '@', 2);
  v_inv public.invites%ROWTYPE;
  v_inst_domain text;
  v_pending RECORD;
BEGIN
  SELECT * INTO v_inv
  FROM public.invites
  WHERE lower(email) = v_email AND accepted_at IS NULL
  LIMIT 1;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'not_invited';
  END IF;

  IF v_inv.institution_id IS NOT NULL THEN
    SELECT lower(email_domain) INTO v_inst_domain
    FROM public.institutions
    WHERE id = v_inv.institution_id;

    IF v_inst_domain IS NULL OR v_domain <> v_inst_domain THEN
      RAISE EXCEPTION 'domain_mismatch';
    END IF;
  END IF;

  INSERT INTO public.profiles (
    id, institution_id, email, full_name, role, school_id, department_id, roll_no, active
  )
  VALUES (
    NEW.id, v_inv.institution_id, v_email, v_inv.full_name, v_inv.role,
    v_inv.school_id, v_inv.department_id, v_inv.roll_no, true
  );

  UPDATE public.invites
  SET accepted_at = now()
  WHERE id = v_inv.id;

  FOR v_pending IN
    SELECT id, course_id, batch_id, institution_id
    FROM public.pending_enrollments
    WHERE lower(email) = v_email
  LOOP
    INSERT INTO public.enrollments (course_id, batch_id, institution_id, student_id)
    VALUES (v_pending.course_id, v_pending.batch_id, v_pending.institution_id, NEW.id)
    ON CONFLICT (course_id, student_id) DO NOTHING;

    DELETE FROM public.pending_enrollments WHERE id = v_pending.id;
  END LOOP;

  PERFORM public.audit(
    'signup',
    'profile',
    NEW.id::text,
    jsonb_build_object('email', v_email, 'role', v_inv.role::text),
    v_inv.institution_id,
    NEW.id
  );

  RETURN NEW;
END;
$$;

CREATE OR REPLACE FUNCTION generate_class_code()
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
    EXIT WHEN NOT EXISTS (SELECT 1 FROM public.batches WHERE class_code = v_code);
  END LOOP;
  RETURN v_code;
END;
$$;

REVOKE ALL ON FUNCTION public.generate_class_code() FROM PUBLIC, anon, authenticated;

CREATE OR REPLACE FUNCTION create_course(
  p_code text,
  p_title text,
  p_ltpc text DEFAULT '0-0-2-1',
  p_programme text DEFAULT 'B.Tech',
  p_semester text DEFAULT 'IV',
  p_section text DEFAULT 'A',
  p_academic_year text DEFAULT '2026-27',
  p_department_id uuid DEFAULT NULL
)
RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_uid uuid := auth.uid();
  v_prof public.profiles%ROWTYPE;
  v_dept uuid;
  v_id uuid;
BEGIN
  IF v_uid IS NULL THEN
    RAISE EXCEPTION 'forbidden';
  END IF;
  SELECT * INTO v_prof FROM public.profiles WHERE id = v_uid AND active = true;
  IF NOT FOUND OR v_prof.role NOT IN ('faculty', 'hod') OR v_prof.institution_id IS NULL THEN
    RAISE EXCEPTION 'forbidden';
  END IF;

  v_dept := COALESCE(p_department_id, v_prof.department_id);
  IF v_dept IS NULL OR NOT EXISTS (
    SELECT 1 FROM public.departments WHERE id = v_dept AND institution_id = v_prof.institution_id
  ) THEN
    RAISE EXCEPTION 'invalid_scope';
  END IF;

  IF trim(coalesce(p_code, '')) = '' OR trim(coalesce(p_title, '')) = '' THEN
    RAISE EXCEPTION 'invalid_input';
  END IF;

  INSERT INTO public.courses (
    institution_id, department_id, faculty_id, code, title, ltpc, programme, semester, section, academic_year
  )
  VALUES (
    v_prof.institution_id,
    v_dept,
    v_uid,
    upper(trim(p_code)),
    trim(p_title),
    trim(coalesce(p_ltpc, '0-0-2-1')),
    trim(coalesce(p_programme, 'B.Tech')),
    trim(coalesce(p_semester, 'IV')),
    trim(coalesce(p_section, 'A')),
    trim(coalesce(p_academic_year, '2026-27'))
  )
  RETURNING id INTO v_id;

  PERFORM public.audit(
    'create_course',
    'course',
    v_id::text,
    jsonb_build_object('code', upper(trim(p_code)), 'title', trim(p_title)),
    v_prof.institution_id
  );

  RETURN v_id;
END;
$$;

CREATE OR REPLACE FUNCTION submit_course_plan(p_course_id uuid)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_co public.courses%ROWTYPE;
  v_co_count integer;
  v_total integer;
BEGIN
  IF NOT is_course_faculty(p_course_id) THEN
    RAISE EXCEPTION 'forbidden';
  END IF;

  SELECT * INTO v_co FROM public.courses WHERE id = p_course_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'not_found';
  END IF;
  IF v_co.plan_status NOT IN ('draft', 'declined') THEN
    RAISE EXCEPTION 'not_editable';
  END IF;

  SELECT count(*) INTO v_co_count FROM public.course_outcomes WHERE course_id = p_course_id;
  IF v_co_count < 1 THEN
    RAISE EXCEPTION 'outcomes_required';
  END IF;

  v_total :=
    COALESCE((v_co.rubric->>'att')::integer, 0)
    + COALESCE((v_co.rubric->>'pre')::integer, 0)
    + COALESCE((v_co.rubric->>'post')::integer, 0)
    + COALESCE((v_co.rubric->>'vis')::integer, 0)
    + COALESCE((v_co.rubric->>'hid')::integer, 0)
    + COALESCE((v_co.rubric->>'viva')::integer, 0);

  IF v_total <> 50 THEN
    RAISE EXCEPTION 'rubric_must_total_50';
  END IF;

  UPDATE public.courses
  SET plan_status = 'sent',
      plan_remark = NULL
  WHERE id = p_course_id;

  PERFORM public.audit(
    'submit_course_plan',
    'course',
    p_course_id::text,
    jsonb_build_object('code', v_co.code, 'outcomes', v_co_count),
    v_co.institution_id
  );
END;
$$;

CREATE OR REPLACE FUNCTION decide_course_plan(
  p_course_id uuid,
  p_approve boolean,
  p_remark text DEFAULT NULL
)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_co public.courses%ROWTYPE;
  v_remark text := nullif(trim(coalesce(p_remark, '')), '');
  v_payload jsonb;
  v_hash text;
BEGIN
  SELECT * INTO v_co FROM public.courses WHERE id = p_course_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'not_found';
  END IF;

  IF my_role() <> 'hod'
     OR v_co.institution_id <> my_institution()
     OR v_co.department_id <> my_department()
     OR v_co.faculty_id = auth.uid() THEN
    RAISE EXCEPTION 'forbidden';
  END IF;

  IF v_co.plan_status <> 'sent' THEN
    RAISE EXCEPTION 'not_pending';
  END IF;

  IF NOT p_approve AND v_remark IS NULL THEN
    RAISE EXCEPTION 'remark_required';
  END IF;

  SELECT jsonb_build_object(
    'rubric', v_co.rubric,
    'outcomes', COALESCE((
      SELECT jsonb_agg(jsonb_build_object('code', o.code, 'statement', o.statement, 'btl', o.btl, 'unit', o.unit) ORDER BY o.code)
      FROM public.course_outcomes o WHERE o.course_id = p_course_id
    ), '[]'::jsonb),
    'map', COALESCE((
      SELECT jsonb_agg(jsonb_build_object('co_id', m.co_id, 'po_code', m.po_code, 'level', m.level) ORDER BY m.co_id, m.po_code)
      FROM public.co_po_map m WHERE m.course_id = p_course_id
    ), '[]'::jsonb)
  ) INTO v_payload;

  v_hash := encode(sha256(convert_to(v_payload::text, 'UTF8')), 'hex');

  UPDATE public.courses
  SET plan_status = CASE WHEN p_approve THEN 'approved'::plan_approval_status ELSE 'declined'::plan_approval_status END,
      plan_remark = v_remark
  WHERE id = p_course_id;

  INSERT INTO public.approvals (
    institution_id, object_type, object_id, approver_id, decision, remark, content_hash
  )
  VALUES (
    v_co.institution_id,
    'course_plan',
    p_course_id,
    auth.uid(),
    CASE WHEN p_approve THEN 'approved'::approval_decision ELSE 'declined'::approval_decision END,
    v_remark,
    v_hash
  );

  PERFORM public.audit(
    CASE WHEN p_approve THEN 'approve_course_plan' ELSE 'decline_course_plan' END,
    'course',
    p_course_id::text,
    jsonb_build_object('remark', v_remark, 'content_hash', v_hash),
    v_co.institution_id
  );
END;
$$;

CREATE OR REPLACE FUNCTION import_roster(
  p_course_id uuid,
  p_rows jsonb
)
RETURNS TABLE (
  batch_id uuid,
  batch_name text,
  class_code text,
  student_count integer
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_co public.courses%ROWTYPE;
  v_inst_domain text;
  v_total integer;
  v_nb integer;
  v_base integer;
  v_rem integer;
  v_idx integer := 0;
  v_b integer;
  v_size integer;
  v_batch_id uuid;
  v_batch_name text;
  v_class_code text;
  v_row jsonb;
  v_email text;
  v_roll text;
  v_name text;
  v_domain text;
  v_prof_id uuid;
  v_school_id uuid;
  v_slots constant text[] := ARRAY['Wed 10:00-12:00', 'Wed 14:00-16:00', 'Thu 10:00-12:00', 'Fri 10:00-12:00'];
BEGIN
  IF NOT is_course_faculty(p_course_id) THEN
    RAISE EXCEPTION 'forbidden';
  END IF;

  SELECT * INTO v_co FROM public.courses WHERE id = p_course_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'not_found';
  END IF;

  IF EXISTS (SELECT 1 FROM public.sessions WHERE course_id = p_course_id AND status = 'conducted') THEN
    RAISE EXCEPTION 'sessions_already_conducted';
  END IF;

  IF p_rows IS NULL OR jsonb_typeof(p_rows) <> 'array' OR jsonb_array_length(p_rows) = 0 THEN
    RAISE EXCEPTION 'empty_roster';
  END IF;

  SELECT lower(email_domain) INTO v_inst_domain FROM public.institutions WHERE id = v_co.institution_id;
  SELECT school_id INTO v_school_id FROM public.departments WHERE id = v_co.department_id;

  -- Validate every row upfront before modifying anything
  FOR v_row IN SELECT value FROM jsonb_array_elements(p_rows) LOOP
    v_email := lower(trim(coalesce(v_row->>'email', '')));
    v_roll := trim(coalesce(v_row->>'roll_no', v_row->>'roll', ''));
    v_name := trim(coalesce(v_row->>'full_name', v_row->>'name', ''));
    v_domain := split_part(v_email, '@', 2);
    IF v_email = '' OR v_roll = '' OR v_name = '' OR position('@' IN v_email) = 0 THEN
      RAISE EXCEPTION 'invalid_input';
    END IF;
    IF v_domain <> v_inst_domain THEN
      RAISE EXCEPTION 'domain_mismatch';
    END IF;
  END LOOP;

  -- Clear prior roster/batches if re-importing before any session is conducted
  DELETE FROM public.pending_enrollments WHERE course_id = p_course_id;
  DELETE FROM public.enrollments WHERE course_id = p_course_id;
  DELETE FROM public.batches WHERE course_id = p_course_id;

  v_total := jsonb_array_length(p_rows);
  v_nb := GREATEST(1, ceil(v_total::numeric / 65.0)::integer);
  v_base := v_total / v_nb;
  v_rem := v_total % v_nb;

  CREATE TEMP TABLE IF NOT EXISTS tmp_roster_out (
    batch_id uuid,
    batch_name text,
    class_code text,
    student_count integer
  ) ON COMMIT DROP;
  TRUNCATE tmp_roster_out;

  FOR v_b IN 0..(v_nb - 1) LOOP
    v_size := v_base + CASE WHEN v_b < v_rem THEN 1 ELSE 0 END;
    v_batch_name := 'Batch ' || chr(65 + v_b);
    v_class_code := generate_class_code();

    INSERT INTO public.batches (course_id, institution_id, name, class_code, slot, room, staff)
    VALUES (
      p_course_id,
      v_co.institution_id,
      v_batch_name,
      v_class_code,
      v_slots[1 + (v_b % array_length(v_slots, 1))],
      'Lab ' || (3 + (v_b % 2))::text,
      'TA ' || (v_b + 1)::text
    )
    RETURNING id INTO v_batch_id;

    FOR v_i IN 0..(v_size - 1) LOOP
      v_row := p_rows->(v_idx + v_i);
      v_email := lower(trim(coalesce(v_row->>'email', '')));
      v_roll := trim(coalesce(v_row->>'roll_no', v_row->>'roll', ''));
      v_name := trim(coalesce(v_row->>'full_name', v_row->>'name', ''));

      SELECT id INTO v_prof_id FROM public.profiles WHERE lower(email) = v_email LIMIT 1;
      IF v_prof_id IS NOT NULL THEN
        INSERT INTO public.enrollments (course_id, batch_id, institution_id, student_id)
        VALUES (p_course_id, v_batch_id, v_co.institution_id, v_prof_id)
        ON CONFLICT (course_id, student_id) DO UPDATE SET batch_id = EXCLUDED.batch_id;
      ELSE
        INSERT INTO public.pending_enrollments (course_id, batch_id, institution_id, email, roll_no, full_name)
        VALUES (p_course_id, v_batch_id, v_co.institution_id, v_email, v_roll, v_name)
        ON CONFLICT (course_id, email) DO UPDATE
          SET batch_id = EXCLUDED.batch_id, roll_no = EXCLUDED.roll_no, full_name = EXCLUDED.full_name;

        INSERT INTO public.invites (
          email, institution_id, role, full_name, school_id, department_id, roll_no, created_by
        )
        VALUES (
          v_email, v_co.institution_id, 'student', v_name, v_school_id, v_co.department_id, v_roll, auth.uid()
        )
        ON CONFLICT (email) DO NOTHING;
      END IF;
    END LOOP;

    v_idx := v_idx + v_size;
    INSERT INTO tmp_roster_out VALUES (v_batch_id, v_batch_name, v_class_code, v_size);
  END LOOP;

  PERFORM public.audit(
    'import_roster',
    'course',
    p_course_id::text,
    jsonb_build_object('students', v_total, 'batches', v_nb),
    v_co.institution_id
  );

  RETURN QUERY SELECT r.batch_id, r.batch_name, r.class_code, r.student_count FROM tmp_roster_out r ORDER BY r.batch_name;
END;
$$;

CREATE OR REPLACE FUNCTION move_student(
  p_course_id uuid,
  p_student_email text,
  p_to_batch_id uuid
)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_email text := lower(trim(coalesce(p_student_email, '')));
  v_inst uuid;
  v_prof_id uuid;
  v_updated integer := 0;
BEGIN
  IF NOT is_course_faculty(p_course_id) THEN
    RAISE EXCEPTION 'forbidden';
  END IF;

  IF EXISTS (SELECT 1 FROM public.sessions WHERE course_id = p_course_id AND status = 'conducted') THEN
    RAISE EXCEPTION 'sessions_already_conducted';
  END IF;

  SELECT institution_id INTO v_inst FROM public.batches WHERE id = p_to_batch_id AND course_id = p_course_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'invalid_scope';
  END IF;

  SELECT id INTO v_prof_id FROM public.profiles WHERE lower(email) = v_email LIMIT 1;
  IF v_prof_id IS NOT NULL THEN
    UPDATE public.enrollments
    SET batch_id = p_to_batch_id
    WHERE course_id = p_course_id AND student_id = v_prof_id;
    GET DIAGNOSTICS v_updated = ROW_COUNT;
  END IF;

  IF v_updated = 0 THEN
    UPDATE public.pending_enrollments
    SET batch_id = p_to_batch_id
    WHERE course_id = p_course_id AND lower(email) = v_email;
    GET DIAGNOSTICS v_updated = ROW_COUNT;
  END IF;

  IF v_updated = 0 THEN
    RAISE EXCEPTION 'not_found';
  END IF;

  PERFORM public.audit(
    'move_student',
    'batch',
    p_to_batch_id::text,
    jsonb_build_object('course_id', p_course_id, 'email', v_email),
    v_inst
  );
END;
$$;

CREATE OR REPLACE FUNCTION join_with_code(p_code text)
RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_uid uuid := auth.uid();
  v_prof public.profiles%ROWTYPE;
  v_batch public.batches%ROWTYPE;
  v_clean text := upper(trim(coalesce(p_code, '')));
  v_on_roster boolean := false;
BEGIN
  IF v_uid IS NULL THEN
    RAISE EXCEPTION 'forbidden';
  END IF;

  SELECT * INTO v_prof FROM public.profiles WHERE id = v_uid AND active = true;
  IF NOT FOUND OR v_prof.role <> 'student' THEN
    RAISE EXCEPTION 'forbidden';
  END IF;

  SELECT * INTO v_batch FROM public.batches WHERE class_code = v_clean;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'invalid_class_code';
  END IF;

  IF v_prof.institution_id <> v_batch.institution_id THEN
    RAISE EXCEPTION 'not_on_roster';
  END IF;

  IF EXISTS (SELECT 1 FROM public.enrollments WHERE course_id = v_batch.course_id AND student_id = v_uid) THEN
    RETURN v_batch.course_id;
  END IF;

  v_on_roster := EXISTS (
    SELECT 1 FROM public.pending_enrollments
    WHERE course_id = v_batch.course_id AND lower(email) = lower(v_prof.email)
  ) OR EXISTS (
    SELECT 1 FROM public.invites
    WHERE institution_id = v_batch.institution_id AND lower(email) = lower(v_prof.email) AND role = 'student'
  );

  IF NOT v_on_roster THEN
    RAISE EXCEPTION 'not_on_roster';
  END IF;

  INSERT INTO public.enrollments (course_id, batch_id, institution_id, student_id)
  VALUES (v_batch.course_id, v_batch.id, v_batch.institution_id, v_uid)
  ON CONFLICT (course_id, student_id) DO NOTHING;

  DELETE FROM public.pending_enrollments
  WHERE course_id = v_batch.course_id AND lower(email) = lower(v_prof.email);

  PERFORM public.audit(
    'join_with_code',
    'batch',
    v_batch.id::text,
    jsonb_build_object('course_id', v_batch.course_id, 'class_code', v_clean),
    v_batch.institution_id
  );

  RETURN v_batch.course_id;
END;
$$;

CREATE OR REPLACE FUNCTION save_session_plan(
  p_course_id uuid,
  p_topics text[],
  p_dates date[],
  p_cos uuid[] DEFAULT NULL,
  p_btls integer[] DEFAULT NULL
)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_co public.courses%ROWTYPE;
  v_len integer;
  v_i integer;
  v_dt date;
  v_co_id uuid;
  v_btl integer;
BEGIN
  IF NOT is_course_faculty(p_course_id) THEN
    RAISE EXCEPTION 'forbidden';
  END IF;

  SELECT * INTO v_co FROM public.courses WHERE id = p_course_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'not_found';
  END IF;

  IF EXISTS (
    SELECT 1 FROM public.sessions WHERE course_id = p_course_id AND status IN ('active', 'conducted')
  ) THEN
    RAISE EXCEPTION 'sessions_already_active';
  END IF;

  v_len := COALESCE(array_length(p_topics, 1), 0);
  IF v_len = 0 OR v_len <> COALESCE(array_length(p_dates, 1), 0) THEN
    RAISE EXCEPTION 'invalid_input';
  END IF;

  DELETE FROM public.sessions WHERE course_id = p_course_id;

  FOR v_i IN 1..v_len LOOP
    v_dt := p_dates[v_i];
    v_co_id := CASE WHEN p_cos IS NOT NULL AND array_length(p_cos, 1) >= v_i THEN p_cos[v_i] ELSE NULL END;
    v_btl := CASE WHEN p_btls IS NOT NULL AND array_length(p_btls, 1) >= v_i THEN COALESCE(p_btls[v_i], 3) ELSE 3 END;

    INSERT INTO public.sessions (
      course_id, institution_id, n, topic, co_id, btl, scheduled_date, status, pre_open, pre_close, post_close
    )
    VALUES (
      p_course_id,
      v_co.institution_id,
      v_i,
      trim(p_topics[v_i]),
      v_co_id,
      GREATEST(1, LEAST(6, v_btl)),
      v_dt,
      'none',
      ((v_dt - 1)::timestamp + time '18:00') AT TIME ZONE 'Asia/Kolkata',
      (v_dt::timestamp + time '09:59') AT TIME ZONE 'Asia/Kolkata',
      (v_dt::timestamp + time '23:59') AT TIME ZONE 'Asia/Kolkata'
    );
  END LOOP;

  PERFORM public.audit(
    'save_session_plan',
    'course',
    p_course_id::text,
    jsonb_build_object('sessions', v_len),
    v_co.institution_id
  );
END;
$$;

CREATE OR REPLACE FUNCTION generate_session_plan(
  p_course_id uuid,
  p_n integer DEFAULT 30
)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_topics text[] := ARRAY[]::text[];
  v_dates date[] := ARRAY[]::date[];
  v_start date := CURRENT_DATE + 7;
  v_i integer;
BEGIN
  IF p_n < 1 OR p_n > 60 THEN
    RAISE EXCEPTION 'invalid_input';
  END IF;
  FOR v_i IN 1..p_n LOOP
    v_topics := array_append(v_topics, 'Session ' || v_i::text);
    v_dates := array_append(v_dates, (v_start + (((v_i - 1) / 2) * 7))::date);
  END LOOP;
  PERFORM public.save_session_plan(p_course_id, v_topics, v_dates);
END;
$$;

GRANT EXECUTE ON FUNCTION
  create_course(text, text, text, text, text, text, text, uuid),
  submit_course_plan(uuid),
  decide_course_plan(uuid, boolean, text),
  import_roster(uuid, jsonb),
  move_student(uuid, text, uuid),
  join_with_code(text),
  save_session_plan(uuid, text[], date[], uuid[], integer[]),
  generate_session_plan(uuid, integer)
TO authenticated;
