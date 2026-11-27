-- Allow super_admin to edit an institution's email_domain.

CREATE OR REPLACE FUNCTION admin_update_institution_domain(
  p_institution_id uuid,
  p_email_domain text
)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_domain text := lower(ltrim(btrim(coalesce(p_email_domain, '')), '@'));
  v_old_domain text;
BEGIN
  IF NOT is_super_admin() THEN
    RAISE EXCEPTION 'forbidden';
  END IF;

  IF v_domain = '' OR position('.' IN v_domain) <= 1 OR position('@' IN v_domain) > 0 THEN
    RAISE EXCEPTION 'invalid_input';
  END IF;

  SELECT email_domain INTO v_old_domain
  FROM public.institutions
  WHERE id = p_institution_id;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'institution_not_found';
  END IF;

  UPDATE public.institutions
  SET email_domain = v_domain
  WHERE id = p_institution_id;

  PERFORM public.audit(
    'update_institution_domain',
    'institution',
    p_institution_id::text,
    jsonb_build_object('old_domain', v_old_domain, 'new_domain', v_domain),
    p_institution_id
  );
END;
$$;

GRANT EXECUTE ON FUNCTION admin_update_institution_domain(uuid, text) TO authenticated;
