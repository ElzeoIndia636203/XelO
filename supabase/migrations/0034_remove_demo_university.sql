-- Remove Demo University seed/test institution and add admin_remove_institution RPC.

DELETE FROM public.institutions
WHERE lower(name) = 'demo university' AND lower(email_domain) = 'gmail.com';

CREATE OR REPLACE FUNCTION admin_remove_institution(p_institution_id uuid)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_inst public.institutions%ROWTYPE;
BEGIN
  IF NOT public.has_role('super_admin') THEN
    RAISE EXCEPTION 'forbidden';
  END IF;

  SELECT * INTO v_inst FROM public.institutions WHERE id = p_institution_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'not_found';
  END IF;

  DELETE FROM public.invites WHERE institution_id = p_institution_id;
  DELETE FROM public.institutions WHERE id = p_institution_id;

  PERFORM public.audit(
    'admin_remove_institution',
    'institution',
    p_institution_id::text,
    jsonb_build_object('name', v_inst.name, 'email_domain', v_inst.email_domain),
    NULL
  );
END;
$$;

REVOKE ALL ON FUNCTION admin_remove_institution(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION admin_remove_institution(uuid) TO authenticated;
