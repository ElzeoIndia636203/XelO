-- Clickable calendar meetings with purpose & duration_minutes, expanded Faculty -> CoE/VC contacts,
-- and calendar_approved_meetings RPC for Student, Faculty, HOD, Dean, CoE, VC.

ALTER TABLE meetings
  ADD COLUMN IF NOT EXISTS duration_minutes integer NOT NULL DEFAULT 30 CHECK (duration_minutes BETWEEN 5 AND 480),
  ADD COLUMN IF NOT EXISTS purpose text NOT NULL DEFAULT '';

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

    -- Faculty -> HOD of department, Dean of school, CoE, or VC/Principal (request meeting)
    SELECT p.id, p.full_name, p.email, p.role, 'superior'::text AS relation
    FROM public.profiles p
    WHERE public.has_role('faculty')
      AND p.active = true
      AND p.id <> v_me.id
      AND p.institution_id = v_me.institution_id
      AND (
        ('hod' = ANY(CASE WHEN cardinality(p.roles) > 0 THEN p.roles ELSE ARRAY[p.role] END) AND p.department_id = v_me.department_id)
        OR ('dean' = ANY(CASE WHEN cardinality(p.roles) > 0 THEN p.roles ELSE ARRAY[p.role] END) AND (v_me.school_id IS NULL OR p.school_id = v_me.school_id))
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
      AND p.department_id = v_me.department_id
      AND 'faculty' = ANY(CASE WHEN cardinality(p.roles) > 0 THEN p.roles ELSE ARRAY[p.role] END)

    UNION ALL

    -- HOD -> Dean (same school), CoE, VC (request meeting)
    SELECT p.id, p.full_name, p.email, p.role, 'superior'::text AS relation
    FROM public.profiles p
    WHERE public.has_role('hod')
      AND p.active = true
      AND p.id <> v_me.id
      AND p.institution_id = v_me.institution_id
      AND (
        ('dean' = ANY(CASE WHEN cardinality(p.roles) > 0 THEN p.roles ELSE ARRAY[p.role] END) AND (v_me.school_id IS NULL OR p.school_id = v_me.school_id))
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
      AND (v_me.school_id IS NULL OR p.school_id = v_me.school_id)
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

DROP FUNCTION IF EXISTS send_hierarchy_message(uuid, text, text, timestamptz, text, uuid);

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

DROP FUNCTION IF EXISTS respond_meeting_request(uuid, boolean);

CREATE OR REPLACE FUNCTION respond_meeting_request(p_meeting_id uuid, p_accept boolean)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_m public.meetings%ROWTYPE;
  v_me_name text;
  v_req_role text;
  v_req_link text;
  v_new_status text := CASE WHEN p_accept THEN 'accepted' ELSE 'declined' END;
BEGIN
  SELECT * INTO v_m FROM public.meetings WHERE id = p_meeting_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'not_found';
  END IF;
  IF v_m.recipient_id <> auth.uid() THEN
    RAISE EXCEPTION 'forbidden';
  END IF;
  IF v_m.status <> 'pending' THEN
    RAISE EXCEPTION 'not_pending';
  END IF;

  SELECT full_name INTO v_me_name FROM public.profiles WHERE id = auth.uid();
  SELECT role INTO v_req_role FROM public.profiles WHERE id = v_m.requester_id;
  v_req_link := CASE
    WHEN v_req_role = 'student' THEN '/student'
    WHEN v_req_role = 'hod' THEN '/hod'
    WHEN v_req_role IN ('dean', 'coe', 'vc') THEN '/oversight'
    ELSE '/faculty'
  END;

  UPDATE public.meetings SET status = v_new_status WHERE id = p_meeting_id;

  PERFORM public.notify(
    v_m.requester_id,
    'meeting_response',
    v_m.title || ' (' || v_new_status || ')',
    COALESCE(v_me_name, 'Recipient') || ' ' || v_new_status || ' your meeting request' ||
      CASE WHEN v_m.scheduled_at IS NOT NULL THEN ' for ' || to_char(v_m.scheduled_at AT TIME ZONE 'Asia/Kolkata', 'DD Mon HH24:MI') || ' IST (' || v_m.duration_minutes::text || ' min)' ELSE '' END || '.',
    v_req_link,
    v_m.institution_id
  );
END;
$$;

CREATE OR REPLACE FUNCTION calendar_approved_meetings()
RETURNS TABLE (
  id uuid,
  title text,
  purpose text,
  duration_minutes integer,
  scheduled_at timestamptz,
  kind text,
  status text,
  other_name text,
  other_role text,
  is_requester boolean
)
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  RETURN QUERY
  SELECT
    m.id,
    m.title,
    m.purpose,
    m.duration_minutes,
    m.scheduled_at,
    m.kind,
    m.status,
    CASE WHEN m.requester_id = auth.uid() THEN coalesce(rec.full_name, rec.email) ELSE coalesce(req.full_name, req.email) END AS other_name,
    CASE WHEN m.requester_id = auth.uid() THEN rec.role ELSE req.role END AS other_role,
    (m.requester_id = auth.uid()) AS is_requester
  FROM public.meetings m
  LEFT JOIN public.profiles req ON req.id = m.requester_id
  LEFT JOIN public.profiles rec ON rec.id = m.recipient_id
  WHERE (m.requester_id = auth.uid() OR m.recipient_id = auth.uid())
    AND m.scheduled_at IS NOT NULL
    AND (m.status = 'accepted' OR (m.kind = 'meeting_scheduled' AND m.status = 'sent'))
  ORDER BY m.scheduled_at ASC;
END;
$$;

GRANT EXECUTE ON FUNCTION
  list_hierarchy_contacts(),
  send_hierarchy_message(uuid, text, text, timestamptz, text, uuid, integer, text),
  respond_meeting_request(uuid, boolean),
  calendar_approved_meetings()
TO authenticated;
