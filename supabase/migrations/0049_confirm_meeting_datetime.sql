-- Allow recipient (faculty/HOD/Dean/etc.) to confirm/adjust date & time when accepting a meeting request,
-- syncing the confirmed meeting to both requester and recipient calendars.

DROP FUNCTION IF EXISTS respond_meeting_request(uuid, boolean);

CREATE OR REPLACE FUNCTION respond_meeting_request(
  p_meeting_id uuid,
  p_accept boolean,
  p_scheduled_at timestamptz DEFAULT NULL
)
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
  v_final_at timestamptz;
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

  v_final_at := CASE WHEN p_accept THEN COALESCE(p_scheduled_at, v_m.scheduled_at) ELSE v_m.scheduled_at END;

  SELECT full_name INTO v_me_name FROM public.profiles WHERE id = auth.uid();
  SELECT role::text INTO v_req_role FROM public.profiles WHERE id = v_m.requester_id;
  v_req_link := CASE
    WHEN v_req_role = 'student' THEN '/student'
    WHEN v_req_role = 'hod' THEN '/hod'
    WHEN v_req_role IN ('dean', 'coe', 'vc') THEN '/oversight'
    ELSE '/faculty'
  END;

  UPDATE public.meetings
  SET status = v_new_status,
      scheduled_at = v_final_at
  WHERE id = p_meeting_id;

  PERFORM public.notify(
    v_m.requester_id,
    'meeting_response',
    v_m.title || ' (' || v_new_status || ')',
    COALESCE(v_me_name, 'Recipient') || ' ' || v_new_status || ' your meeting request' ||
      CASE WHEN v_final_at IS NOT NULL THEN ' for ' || to_char(v_final_at AT TIME ZONE 'Asia/Kolkata', 'DD Mon HH24:MI') || ' IST (' || v_m.duration_minutes::text || ' min)' ELSE '' END || '.',
    v_req_link,
    v_m.institution_id
  );
END;
$$;

GRANT EXECUTE ON FUNCTION respond_meeting_request(uuid, boolean, timestamptz) TO authenticated;
