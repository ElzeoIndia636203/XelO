-- Hierarchy notifications, meeting requests/scheduling, and HOD faculty performance summary.

CREATE TABLE meetings (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  institution_id uuid NOT NULL REFERENCES institutions(id) ON DELETE CASCADE,
  requester_id uuid NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
  recipient_id uuid NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
  course_id uuid REFERENCES courses(id) ON DELETE SET NULL,
  kind text NOT NULL CHECK (kind IN ('notify', 'meeting_request', 'meeting_scheduled')),
  title text NOT NULL,
  scheduled_at timestamptz,
  note text NOT NULL DEFAULT '',
  status text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'accepted', 'declined', 'sent')),
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX idx_meetings_recipient ON meetings(recipient_id, created_at DESC);
CREATE INDEX idx_meetings_requester ON meetings(requester_id, created_at DESC);

ALTER TABLE meetings ENABLE ROW LEVEL SECURITY;

GRANT SELECT ON meetings TO authenticated;
GRANT ALL ON meetings TO service_role;

CREATE POLICY meetings_read ON meetings
  FOR SELECT TO authenticated
  USING (requester_id = auth.uid() OR recipient_id = auth.uid() OR has_role('super_admin'));

CREATE OR REPLACE FUNCTION hod_faculty_summary(p_department_id uuid DEFAULT NULL)
RETURNS TABLE (
  faculty_id uuid,
  faculty_name text,
  faculty_email text,
  course_id uuid,
  course_code text,
  course_title text,
  sessions_total integer,
  sessions_conducted integer,
  missed_classes integer,
  streak integer,
  attendance_pct numeric,
  avg_score_pct numeric
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

  v_dept := COALESCE(p_department_id, v_me.department_id);

  RETURN QUERY
  SELECT
    p.id AS faculty_id,
    p.full_name AS faculty_name,
    p.email AS faculty_email,
    c.id AS course_id,
    c.code AS course_code,
    c.title AS course_title,
    (SELECT count(*)::integer FROM public.sessions s WHERE s.course_id = c.id) AS sessions_total,
    (SELECT count(*)::integer FROM public.sessions s WHERE s.course_id = c.id AND s.status = 'conducted') AS sessions_conducted,
    (SELECT count(*)::integer FROM public.sessions s
      WHERE s.course_id = c.id
        AND s.scheduled_date IS NOT NULL
        AND s.scheduled_date < (now() AT TIME ZONE 'Asia/Kolkata')::date
        AND s.status <> 'conducted') AS missed_classes,
    COALESCE((
      SELECT count(*)::integer
      FROM public.sessions s
      WHERE s.course_id = c.id
        AND s.status = 'conducted'
        AND s.n > COALESCE((
          SELECT max(s2.n)
          FROM public.sessions s2
          WHERE s2.course_id = c.id
            AND s2.scheduled_date IS NOT NULL
            AND s2.scheduled_date < (now() AT TIME ZONE 'Asia/Kolkata')::date
            AND s2.status <> 'conducted'
        ), 0)
    ), 0) AS streak,
    COALESCE((
      SELECT round(100.0 * count(*) FILTER (WHERE a.status IN ('present', 'late')) / NULLIF(count(*), 0), 1)
      FROM public.attendance a
      JOIN public.sessions s ON s.id = a.session_id
      WHERE s.course_id = c.id
    ), 0)::numeric AS attendance_pct,
    COALESCE((
      SELECT round(avg(CASE WHEN sub.passed THEN 100.0 ELSE 0.0 END), 1)
      FROM public.submissions sub
      JOIN public.sessions s ON s.id = sub.session_id
      WHERE s.course_id = c.id AND sub.mode = 'submit'
    ), 0)::numeric AS avg_score_pct
  FROM public.courses c
  JOIN public.profiles p ON p.id = c.faculty_id
  WHERE (public.has_role('super_admin') OR c.institution_id = v_me.institution_id)
    AND (v_dept IS NULL OR c.department_id = v_dept)
  ORDER BY p.full_name, c.code;
END;
$$;

CREATE OR REPLACE FUNCTION list_hierarchy_contacts()
RETURNS TABLE (
  id uuid,
  full_name text,
  email text,
  role user_role,
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

    -- Faculty -> HOD of department or Dean of school (request meeting)
    SELECT p.id, p.full_name, p.email, p.role, 'superior'::text AS relation
    FROM public.profiles p
    WHERE public.has_role('faculty')
      AND p.active = true
      AND p.id <> v_me.id
      AND p.institution_id = v_me.institution_id
      AND (
        ('hod' = ANY(CASE WHEN cardinality(p.roles) > 0 THEN p.roles ELSE ARRAY[p.role] END) AND p.department_id = v_me.department_id)
        OR ('dean' = ANY(CASE WHEN cardinality(p.roles) > 0 THEN p.roles ELSE ARRAY[p.role] END) AND p.school_id = v_me.school_id)
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

CREATE OR REPLACE FUNCTION send_hierarchy_message(
  p_recipient_id uuid,
  p_kind text,
  p_title text,
  p_scheduled_at timestamptz DEFAULT NULL,
  p_note text DEFAULT '',
  p_course_id uuid DEFAULT NULL
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
    -- Students cannot notify or schedule meetings; only request meetings.
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
    institution_id, requester_id, recipient_id, course_id, kind, title, scheduled_at, note, status
  )
  VALUES (
    COALESCE(v_me.institution_id, v_rec.institution_id),
    v_me.id, p_recipient_id, p_course_id, p_kind, v_clean_title, p_scheduled_at, COALESCE(btrim(p_note), ''), v_status
  )
  RETURNING id INTO v_id;

  v_link := CASE
    WHEN v_rec.role = 'student' THEN '/app/student'
    WHEN v_rec.role = 'hod' THEN '/app/hod'
    WHEN v_rec.role IN ('dean', 'coe', 'vc') THEN '/app/oversight'
    ELSE '/app/faculty'
  END;

  v_body := trim(
    concat_ws(
      ' · ',
      'From ' || v_me.full_name,
      CASE WHEN p_scheduled_at IS NOT NULL THEN to_char(p_scheduled_at AT TIME ZONE 'Asia/Kolkata', 'DD Mon HH24:MI') || ' IST' ELSE NULL END,
      NULLIF(btrim(COALESCE(p_note, '')), '')
    )
  );

  PERFORM public.notify(p_recipient_id, p_kind, v_clean_title, v_body, v_link, v_rec.institution_id);
  PERFORM public.audit(
    p_kind,
    'meeting',
    v_id::text,
    jsonb_build_object('recipient_id', p_recipient_id, 'title', v_clean_title),
    COALESCE(v_me.institution_id, v_rec.institution_id)
  );

  RETURN v_id;
END;
$$;

CREATE OR REPLACE FUNCTION respond_meeting_request(p_meeting_id uuid, p_accept boolean)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_m public.meetings%ROWTYPE;
  v_me_name text;
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

  UPDATE public.meetings SET status = v_new_status WHERE id = p_meeting_id;

  PERFORM public.notify(
    v_m.requester_id,
    'meeting_response',
    v_m.title || ' (' || v_new_status || ')',
    COALESCE(v_me_name, 'Recipient') || ' ' || v_new_status || ' your meeting request.',
    '',
    v_m.institution_id
  );
END;
$$;

GRANT EXECUTE ON FUNCTION
  hod_faculty_summary(uuid),
  list_hierarchy_contacts(),
  send_hierarchy_message(uuid, text, text, timestamptz, text, uuid),
  respond_meeting_request(uuid, boolean)
TO authenticated;
