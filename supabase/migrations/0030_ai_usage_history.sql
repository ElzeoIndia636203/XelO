-- Super Admin AI credit usage history RPC showing exact feature, course, status, and timestamp per run.

CREATE OR REPLACE FUNCTION admin_ai_usage_history(
  p_user_id uuid DEFAULT NULL,
  p_limit integer DEFAULT 100
)
RETURNS TABLE (
  id uuid,
  user_id uuid,
  faculty_name text,
  faculty_email text,
  institution_name text,
  feature text,
  course_code text,
  course_title text,
  status text,
  charged boolean,
  at timestamptz
)
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  IF NOT public.has_role('super_admin') THEN
    RAISE EXCEPTION 'forbidden';
  END IF;

  RETURN QUERY
  SELECT
    r.id,
    r.user_id,
    coalesce(p.full_name, p.email, 'Unknown') AS faculty_name,
    coalesce(p.email, '') AS faculty_email,
    coalesce(i.name, '') AS institution_name,
    r.feature,
    c.code AS course_code,
    c.title AS course_title,
    r.status,
    r.charged,
    r.at
  FROM public.ai_runs r
  LEFT JOIN public.profiles p ON p.id = r.user_id
  LEFT JOIN public.institutions i ON i.id = r.institution_id
  LEFT JOIN public.courses c ON c.id = r.course_id
  WHERE (p_user_id IS NULL OR r.user_id = p_user_id)
  ORDER BY r.at DESC
  LIMIT least(greatest(coalesce(p_limit, 100), 1), 300);
END;
$$;

REVOKE ALL ON FUNCTION admin_ai_usage_history(uuid, integer) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION admin_ai_usage_history(uuid, integer) TO authenticated;
