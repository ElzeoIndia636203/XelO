-- Allow enrolled students to send meeting_request to their course faculty directly
-- even if list_hierarchy_contacts() fails or returns empty.
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
      SELECT 1 FROM public.enrollments e
      JOIN public.courses c ON c.id = e.course_id
      WHERE e.student_id = v_me.id AND c.faculty_id = p_recipient_id
    ) INTO v_allowed;

    IF NOT v_allowed THEN
      BEGIN
        SELECT EXISTS (
          SELECT 1 FROM public.list_hierarchy_contacts() c
          WHERE c.id = p_recipient_id AND c.relation = 'superior'
        ) INTO v_allowed;
      EXCEPTION WHEN OTHERS THEN
        v_allowed := false;
      END;
    END IF;
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
      'From ' || coalesce(NULLIF(trim(v_me.full_name), ''), v_me.email),
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

GRANT EXECUTE ON FUNCTION send_hierarchy_message(uuid, text, text, timestamptz, text, uuid, integer, text) TO authenticated;
