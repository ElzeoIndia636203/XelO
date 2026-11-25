-- Super admin user/invite removal with protected super-admin hierarchy.

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
  v_actor_email text;
  v_target_email text := lower(btrim(COALESCE(p_target_email, '')));
BEGIN
  SELECT lower(email) INTO v_actor_email
  FROM public.profiles
  WHERE id = p_actor_id;

  -- Hariprasath K cannot be removed/disabled by anybody else.
  IF v_target_email = 'hariprasathk@flyy4.com' THEN
    RAISE EXCEPTION 'forbidden';
  END IF;

  -- Dev cannot remove/disable Gowtham sir.
  IF v_actor_email = 'dev.elzeo@flyy4.com'
     AND v_target_email = 'gowtham.manivel@flyy4.com' THEN
    RAISE EXCEPTION 'forbidden';
  END IF;

  -- Dev cannot be removed/disabled except by Hariprasath K or Gowtham sir.
  IF v_target_email = 'dev.elzeo@flyy4.com'
     AND COALESCE(v_actor_email, '') NOT IN (
       'hariprasathk@flyy4.com',
       'gowtham.manivel@flyy4.com'
     ) THEN
    RAISE EXCEPTION 'forbidden';
  END IF;
END;
$$;

CREATE OR REPLACE FUNCTION admin_set_active(p_user_id uuid, p_active boolean)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_prof public.profiles%ROWTYPE;
BEGIN
  IF NOT is_super_admin() THEN
    RAISE EXCEPTION 'forbidden';
  END IF;
  IF p_user_id = auth.uid() AND NOT p_active THEN
    RAISE EXCEPTION 'cannot_deactivate_self';
  END IF;

  SELECT * INTO v_prof FROM public.profiles WHERE id = p_user_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'not_found';
  END IF;

  IF NOT p_active THEN
    PERFORM public.assert_can_modify_super_admin_target(auth.uid(), v_prof.email);
  END IF;

  UPDATE public.profiles SET active = p_active WHERE id = p_user_id;

  PERFORM public.audit(
    CASE WHEN p_active THEN 'enable_user' ELSE 'disable_user' END,
    'profile',
    p_user_id::text,
    jsonb_build_object('email', v_prof.email, 'active', p_active),
    v_prof.institution_id
  );
END;
$$;

CREATE OR REPLACE FUNCTION admin_remove_user(
  p_user_id uuid DEFAULT NULL,
  p_invite_id uuid DEFAULT NULL
)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_prof public.profiles%ROWTYPE;
  v_inv public.invites%ROWTYPE;
BEGIN
  IF NOT is_super_admin() THEN
    RAISE EXCEPTION 'forbidden';
  END IF;

  IF p_user_id IS NULL AND p_invite_id IS NULL THEN
    RAISE EXCEPTION 'invalid_input';
  END IF;

  IF p_invite_id IS NOT NULL THEN
    SELECT * INTO v_inv FROM public.invites WHERE id = p_invite_id;
    IF NOT FOUND THEN
      RAISE EXCEPTION 'not_found';
    END IF;

    PERFORM public.assert_can_modify_super_admin_target(auth.uid(), v_inv.email);

    DELETE FROM public.invites WHERE id = p_invite_id;

    PERFORM public.audit(
      'remove_invite',
      'invite',
      p_invite_id::text,
      jsonb_build_object('email', v_inv.email, 'role', v_inv.role::text),
      v_inv.institution_id
    );
    RETURN;
  END IF;

  IF p_user_id = auth.uid() THEN
    RAISE EXCEPTION 'cannot_deactivate_self';
  END IF;

  SELECT * INTO v_prof FROM public.profiles WHERE id = p_user_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'not_found';
  END IF;

  PERFORM public.assert_can_modify_super_admin_target(auth.uid(), v_prof.email);

  DELETE FROM public.invites WHERE lower(email) = lower(v_prof.email);
  UPDATE public.profiles SET active = false WHERE id = p_user_id;

  PERFORM public.audit(
    'remove_user',
    'profile',
    p_user_id::text,
    jsonb_build_object('email', v_prof.email, 'role', v_prof.role::text),
    v_prof.institution_id
  );
END;
$$;

GRANT EXECUTE ON FUNCTION admin_remove_user(uuid, uuid) TO authenticated;
