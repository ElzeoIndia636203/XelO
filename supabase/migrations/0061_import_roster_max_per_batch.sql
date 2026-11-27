-- Add p_max_per_batch (1..65, default 65) to import_roster and normalize institution domain.

DROP FUNCTION IF EXISTS import_roster(uuid, jsonb, boolean);

CREATE OR REPLACE FUNCTION import_roster(
  p_course_id uuid,
  p_rows jsonb,
  p_allow_personal boolean DEFAULT false,
  p_max_per_batch integer DEFAULT 65
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
  v_cap integer := least(greatest(COALESCE(p_max_per_batch, 65), 1), 65);
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

  SELECT lower(ltrim(btrim(email_domain), '@')) INTO v_inst_domain FROM public.institutions WHERE id = v_co.institution_id;
  SELECT school_id INTO v_school_id FROM public.departments WHERE id = v_co.department_id;

  FOR v_row IN SELECT value FROM jsonb_array_elements(p_rows) LOOP
    v_email := lower(trim(coalesce(v_row->>'email', '')));
    v_roll := trim(coalesce(v_row->>'roll_no', v_row->>'roll', ''));
    v_name := trim(coalesce(v_row->>'full_name', v_row->>'name', ''));
    v_domain := split_part(v_email, '@', 2);
    IF v_email = '' OR v_roll = '' OR v_name = '' OR position('@' IN v_email) = 0 THEN
      RAISE EXCEPTION 'invalid_input';
    END IF;
    IF p_allow_personal THEN
      IF v_domain <> v_inst_domain AND v_domain NOT IN ('gmail.com', 'outlook.com') THEN
        RAISE EXCEPTION 'domain_mismatch';
      END IF;
    ELSE
      IF v_domain <> v_inst_domain THEN
        RAISE EXCEPTION 'domain_mismatch';
      END IF;
    END IF;
  END LOOP;

  DELETE FROM public.pending_enrollments WHERE course_id = p_course_id;
  DELETE FROM public.enrollments WHERE course_id = p_course_id;
  DELETE FROM public.batches WHERE course_id = p_course_id;

  v_total := jsonb_array_length(p_rows);
  v_nb := GREATEST(1, ceil(v_total::numeric / v_cap::numeric)::integer);
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
    jsonb_build_object(
      'students', v_total,
      'batches', v_nb,
      'max_per_batch', v_cap,
      'allow_personal', p_allow_personal
    ),
    v_co.institution_id
  );

  RETURN QUERY SELECT r.batch_id, r.batch_name, r.class_code, r.student_count FROM tmp_roster_out r ORDER BY r.batch_name;
END;
$$;

REVOKE ALL ON FUNCTION import_roster(uuid, jsonb, boolean, integer) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION import_roster(uuid, jsonb, boolean, integer) TO authenticated;
