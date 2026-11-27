-- Allow dev.elzeo@flyy4.com to be invited as faculty/HOD by removing its
-- hardcoded super_admin invite and protection rule, and normalize any
-- institution email_domain stored with a leading '@'.

UPDATE public.institutions
SET email_domain = lower(ltrim(btrim(email_domain), '@'))
WHERE email_domain LIKE '@%';

DELETE FROM public.invites
WHERE lower(email) = 'dev.elzeo@flyy4.com';

CREATE OR REPLACE FUNCTION assert_can_modify_super_admin_target(
  p_actor_id uuid,
  p_target_email text
)
RETURNS void
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_target_email text := lower(btrim(COALESCE(p_target_email, '')));
BEGIN
  -- Hariprasath K cannot be removed/disabled by anybody else.
  IF v_target_email = 'hariprasathk@flyy4.com' THEN
    RAISE EXCEPTION 'forbidden';
  END IF;
END;
$$;
