-- Staff Busy Days (Faculty to VC) blocking meeting requests on those days,
-- plus null-safe hierarchy contact matching for department_id / school_id.

CREATE TABLE user_busy_days (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  institution_id uuid NOT NULL REFERENCES institutions(id) ON DELETE CASCADE,
  user_id uuid NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
  day date NOT NULL,
  reason text NOT NULL DEFAULT 'Busy',
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (user_id, day)
);

CREATE INDEX idx_user_busy_days_user ON user_busy_days(user_id, day);

ALTER TABLE user_busy_days ENABLE ROW LEVEL SECURITY;

GRANT SELECT, INSERT, DELETE ON user_busy_days TO authenticated;
GRANT ALL ON user_busy_days TO service_role;

CREATE POLICY user_busy_days_read ON user_busy_days
  FOR SELECT TO authenticated
  USING (has_role('super_admin') OR institution_id = my_institution());

CREATE POLICY user_busy_days_write ON user_busy_days
  FOR ALL TO authenticated
  USING (user_id = auth.uid())
  WITH CHECK (user_id = auth.uid());

CREATE OR REPLACE FUNCTION toggle_busy_day(
  p_day date,
  p_reason text DEFAULT 'Busy'
)
RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_me public.profiles%ROWTYPE;
  v_exists boolean;
BEGIN
  SELECT * INTO v_me FROM public.profiles WHERE id = auth.uid() AND active = true;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'forbidden';
  END IF;

  IF NOT (
    public.has_role('faculty')
    OR public.has_role('hod')
    OR public.has_role('dean')
    OR public.has_role('coe')
    OR public.has_role('vc')
    OR public.has_role('super_admin')
  ) THEN
    RAISE EXCEPTION 'forbidden';
  END IF;

  SELECT EXISTS (
    SELECT 1 FROM public.user_busy_days WHERE user_id = v_me.id AND day = p_day
  ) INTO v_exists;

  IF v_exists THEN
    DELETE FROM public.user_busy_days WHERE user_id = v_me.id AND day = p_day;
    RETURN false;
  ELSE
    INSERT INTO public.user_busy_days (institution_id, user_id, day, reason)
    VALUES (v_me.institution_id, v_me.id, p_day, coalesce(nullif(btrim(p_reason), ''), 'Busy'));
    RETURN true;
  END IF;
END;
$$;

CREATE OR REPLACE FUNCTION list_busy_days(p_user_id uuid DEFAULT NULL)
RETURNS TABLE (
  id uuid,
  user_id uuid,
  day date,
  reason text
)
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_me public.profiles%ROWTYPE;
  v_target uuid := coalesce(p_user_id, auth.uid());
BEGIN
  SELECT * INTO v_me FROM public.profiles WHERE id = auth.uid() AND active = true;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'forbidden';
  END IF;

  RETURN QUERY
  SELECT b.id, b.user_id, b.day, b.reason
  FROM public.user_busy_days b
  WHERE b.user_id = v_target
    AND (public.has_role('super_admin') OR b.institution_id = v_me.institution_id)
  ORDER BY b.day ASC;
END;
$$;

DROP FUNCTION IF EXISTS list_hierarchy_contacts();

CREATE OR REPLACE FUNCTION list_hierarchy_contacts()
RETURNS TABLE (
  id uuid,
  full_name text,
  email text,
  role text,
  relation text
)
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_me public.profiles%ROWTYPE;
BEGIN
  SELECT * INTO v_me FROM public.profiles WHERE id = auth.uid() AND active = true;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'forbidden';
  END IF;

  RETURN QUERY
  SELECT DISTINCT ON (t.id, t.relation)
    t.id, t.full_name, t.email, t.role, t.relation
  FROM (
    -- Student -> Faculty of enrolled courses (request meeting)
    SELECT p.id, p.full_name, p.email, p.role, 'superior'::text AS relation
    FROM public.enrollments e
    JOIN public.courses c ON c.id = e.course_id
    JOIN public.profiles p ON p.id = c.faculty_id AND p.active = true
    WHERE public.has_role('student') AND e.student_id = v_me.id

    UNION ALL

    -- Faculty -> Enrolled students (notify / schedule meeting)
    SELECT p.id, p.full_name, p.email, p.role, 'subordinate'::text AS relation
    FROM public.courses c
    JOIN public.enrollments e ON e.course_id = c.id
    JOIN public.profiles p ON p.id = e.student_id AND p.active = true
    WHERE public.has_role('faculty') AND c.faculty_id = v_me.id

    UNION ALL

    -- Faculty -> HOD, Dean, CoE, VC/Principal (request meeting)
    SELECT p.id, p.full_name, p.email, p.role, 'superior'::text AS relation
    FROM public.profiles p
    WHERE public.has_role('faculty')
      AND p.active = true
      AND p.id <> v_me.id
      AND p.institution_id = v_me.institution_id
      AND (
        ('hod' = ANY(CASE WHEN cardinality(p.roles) > 0 THEN p.roles ELSE ARRAY[p.role] END)
          AND (v_me.department_id IS NULL OR p.department_id IS NULL OR p.department_id = v_me.department_id))
        OR ('dean' = ANY(CASE WHEN cardinality(p.roles) > 0 THEN p.roles ELSE ARRAY[p.role] END)
          AND (v_me.school_id IS NULL OR p.school_id IS NULL OR p.school_id = v_me.school_id))
        OR 'coe' = ANY(CASE WHEN cardinality(p.roles) > 0 THEN p.roles ELSE ARRAY[p.role] END)
        OR 'vc' = ANY(CASE WHEN cardinality(p.roles) > 0 THEN p.roles ELSE ARRAY[p.role] END)
      )

    UNION ALL

    -- HOD -> Faculty in department (notify / schedule meeting)
    SELECT p.id, p.full_name, p.email, p.role, 'subordinate'::text AS relation
    FROM public.profiles p
    WHERE public.has_role('hod')
      AND p.active = true
      AND p.id <> v_me.id
      AND p.institution_id = v_me.institution_id
      AND (v_me.department_id IS NULL OR p.department_id IS NULL OR p.department_id = v_me.department_id)
      AND 'faculty' = ANY(CASE WHEN cardinality(p.roles) > 0 THEN p.roles ELSE ARRAY[p.role] END)

    UNION ALL

    -- HOD -> Dean, CoE, VC (request meeting)
    SELECT p.id, p.full_name, p.email, p.role, 'superior'::text AS relation
    FROM public.profiles p
    WHERE public.has_role('hod')
      AND p.active = true
      AND p.id <> v_me.id
      AND p.institution_id = v_me.institution_id
      AND (
        ('dean' = ANY(CASE WHEN cardinality(p.roles) > 0 THEN p.roles ELSE ARRAY[p.role] END)
          AND (v_me.school_id IS NULL OR p.school_id IS NULL OR p.school_id = v_me.school_id))
        OR 'coe' = ANY(CASE WHEN cardinality(p.roles) > 0 THEN p.roles ELSE ARRAY[p.role] END)
        OR 'vc' = ANY(CASE WHEN cardinality(p.roles) > 0 THEN p.roles ELSE ARRAY[p.role] END)
      )

    UNION ALL

    -- Dean -> HODs in school (notify / schedule meeting)
    SELECT p.id, p.full_name, p.email, p.role, 'subordinate'::text AS relation
    FROM public.profiles p
    WHERE public.has_role('dean')
      AND p.active = true
      AND p.id <> v_me.id
      AND p.institution_id = v_me.institution_id
      AND (v_me.school_id IS NULL OR p.school_id IS NULL OR p.school_id = v_me.school_id)
      AND 'hod' = ANY(CASE WHEN cardinality(p.roles) > 0 THEN p.roles ELSE ARRAY[p.role] END)

    UNION ALL

    -- CoE -> Deans in institution (notify / schedule meeting)
    SELECT p.id, p.full_name, p.email, p.role, 'subordinate'::text AS relation
    FROM public.profiles p
    WHERE public.has_role('coe')
      AND p.active = true
      AND p.id <> v_me.id
      AND p.institution_id = v_me.institution_id
      AND 'dean' = ANY(CASE WHEN cardinality(p.roles) > 0 THEN p.roles ELSE ARRAY[p.role] END)

    UNION ALL

    -- VC -> Everybody in institution except students (notify / schedule meeting)
    SELECT p.id, p.full_name, p.email, p.role, 'subordinate'::text AS relation
    FROM public.profiles p
    WHERE public.has_role('vc')
      AND p.active = true
      AND p.id <> v_me.id
      AND p.institution_id = v_me.institution_id
      AND p.role <> 'student'
      AND NOT ('student' = ANY(CASE WHEN cardinality(p.roles) > 0 THEN p.roles ELSE ARRAY[p.role] END))
  ) t
  ORDER BY t.id, t.relation;
END;
$$;

DROP FUNCTION IF EXISTS send_hierarchy_message(uuid, text, text, timestamptz, text, uuid, integer, text);

CREATE OR REPLACE FUNCTION send_hierarchy_message(
  p_recipient_id uuid,
  p_kind text,
  p_title text,
  p_scheduled_at timestamptz DEFAULT NULL,
  p_note text DEFAULT '',
  p_course_id uuid DEFAULT NULL,
  p_duration_minutes integer DEFAULT 30,
  p_purpose text DEFAULT ''
)
RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_me public.profiles%ROWTYPE;
  v_rec public.profiles%ROWTYPE;
  v_clean_title text := btrim(COALESCE(p_title, ''));
  v_clean_purpose text := btrim(COALESCE(p_purpose, ''));
  v_dur integer := least(greatest(COALESCE(p_duration_minutes, 30), 5), 480);
  v_allowed boolean := false;
  v_status text;
  v_id uuid;
  v_link text;
  v_body text;
  v_req_day date;
BEGIN
  SELECT * INTO v_me FROM public.profiles WHERE id = auth.uid() AND active = true;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'forbidden';
  END IF;

  IF p_kind NOT IN ('notify', 'meeting_request', 'meeting_scheduled') OR v_clean_title = '' THEN
    RAISE EXCEPTION 'invalid_input';
  END IF;

  SELECT * INTO v_rec FROM public.profiles WHERE id = p_recipient_id AND active = true;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'not_found';
  END IF;

  IF p_kind = 'meeting_request' THEN
    SELECT EXISTS (
      SELECT 1 FROM public.list_hierarchy_contacts() c
      WHERE c.id = p_recipient_id AND c.relation = 'superior'
    ) INTO v_allowed;
  ELSE
    IF public.has_role('student') AND NOT (
      public.has_role('faculty') OR public.has_role('hod') OR public.has_role('dean') OR public.has_role('coe') OR public.has_role('vc')
    ) THEN
      v_allowed := false;
    ELSE
      SELECT EXISTS (
        SELECT 1 FROM public.list_hierarchy_contacts() c
        WHERE c.id = p_recipient_id AND c.relation = 'subordinate'
      ) INTO v_allowed;
    END IF;
  END IF;

  IF NOT v_allowed THEN
    RAISE EXCEPTION 'forbidden';
  END IF;

  IF p_kind = 'meeting_request' AND p_scheduled_at IS NOT NULL THEN
    v_req_day := (p_scheduled_at AT TIME ZONE 'Asia/Kolkata')::date;
    IF EXISTS (
      SELECT 1 FROM public.user_busy_days b
      WHERE b.user_id = p_recipient_id AND b.day = v_req_day
    ) THEN
      RAISE EXCEPTION 'recipient_busy_on_day';
    END IF;
  END IF;

  v_status := CASE WHEN p_kind = 'meeting_request' THEN 'pending' ELSE 'sent' END;

  INSERT INTO public.meetings (
    institution_id, requester_id, recipient_id, course_id, kind, title, scheduled_at, duration_minutes, purpose, note, status
  )
  VALUES (
    COALESCE(v_me.institution_id, v_rec.institution_id),
    v_me.id, p_recipient_id, p_course_id, p_kind, v_clean_title, p_scheduled_at, v_dur, v_clean_purpose, COALESCE(btrim(p_note), ''), v_status
  )
  RETURNING id INTO v_id;

  v_link := CASE
    WHEN v_rec.role = 'student' THEN '/student'
    WHEN v_rec.role = 'hod' THEN '/hod'
    WHEN v_rec.role IN ('dean', 'coe', 'vc') THEN '/oversight'
    ELSE '/faculty'
  END;

  v_body := trim(
    concat_ws(
      ' · ',
      'From ' || v_me.full_name,
      CASE WHEN v_clean_purpose <> '' THEN 'Purpose: ' || v_clean_purpose ELSE NULL END,
      CASE WHEN p_scheduled_at IS NOT NULL THEN to_char(p_scheduled_at AT TIME ZONE 'Asia/Kolkata', 'DD Mon HH24:MI') || ' IST (' || v_dur::text || ' min)' ELSE NULL END,
      NULLIF(btrim(COALESCE(p_note, '')), '')
    )
  );

  PERFORM public.notify(p_recipient_id, p_kind, v_clean_title, v_body, v_link, v_rec.institution_id);
  PERFORM public.audit(
    p_kind,
    'meeting',
    v_id::text,
    jsonb_build_object('recipient_id', p_recipient_id, 'title', v_clean_title, 'duration_minutes', v_dur),
    COALESCE(v_me.institution_id, v_rec.institution_id)
  );

  RETURN v_id;
END;
$$;

GRANT EXECUTE ON FUNCTION
  toggle_busy_day(date, text),
  list_busy_days(uuid),
  list_hierarchy_contacts(),
  send_hierarchy_message(uuid, text, text, timestamptz, text, uuid, integer, text)
TO authenticated;
