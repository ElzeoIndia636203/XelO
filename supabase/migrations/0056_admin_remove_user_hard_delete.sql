-- Hard-delete auth.users (cascading to profiles) in admin_remove_user when no
-- restrictive foreign keys (courses, approvals, viva) exist; otherwise fall back
-- to soft-disabling (active = false).

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
  v_deleted boolean := false;
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

  BEGIN
    DELETE FROM auth.users WHERE id = p_user_id;
    v_deleted := true;
  EXCEPTION
    WHEN foreign_key_violation THEN
      UPDATE public.profiles SET active = false WHERE id = p_user_id;
      v_deleted := false;
  END;

  PERFORM public.audit(
    'remove_user',
    'profile',
    p_user_id::text,
    jsonb_build_object('email', v_prof.email, 'role', v_prof.role::text, 'hard_deleted', v_deleted),
    v_prof.institution_id
  );
END;
$$;

GRANT EXECUTE ON FUNCTION admin_remove_user(uuid, uuid) TO authenticated;
