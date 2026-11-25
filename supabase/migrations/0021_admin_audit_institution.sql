-- Super admin audit feed scoped by onboarded institution, plus Realtime publication for audit_log.

CREATE OR REPLACE FUNCTION admin_audit_feed_by_institution(
  p_institution_id uuid DEFAULT NULL,
  p_limit integer DEFAULT 200
)
RETURNS TABLE (
  id uuid,
  at timestamptz,
  action text,
  object_type text,
  object_id text,
  actor_name text,
  actor_role user_role,
  actor_email text,
  institution_id uuid,
  institution_name text,
  detail jsonb
)
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  IF NOT is_super_admin() THEN
    RAISE EXCEPTION 'forbidden';
  END IF;

  RETURN QUERY
  SELECT
    al.id,
    al.at,
    al.action,
    al.object_type,
    al.object_id,
    COALESCE(p.full_name, 'system'),
    p.role,
    p.email,
    al.institution_id,
    i.name,
    al.detail
  FROM public.audit_log al
  LEFT JOIN public.profiles p ON p.id = al.actor_id
  LEFT JOIN public.institutions i ON i.id = al.institution_id
  WHERE p_institution_id IS NULL OR al.institution_id = p_institution_id
  ORDER BY al.at DESC
  LIMIT GREATEST(1, LEAST(COALESCE(p_limit, 200), 1000));
END;
$$;

GRANT EXECUTE ON FUNCTION admin_audit_feed_by_institution(uuid, integer) TO authenticated;

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_publication WHERE pubname = 'supabase_realtime') THEN
    EXECUTE 'ALTER PUBLICATION supabase_realtime ADD TABLE public.audit_log';
  END IF;
EXCEPTION
  WHEN duplicate_object OR insufficient_privilege THEN NULL;
END $$;
