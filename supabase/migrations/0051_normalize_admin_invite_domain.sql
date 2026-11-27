-- Normalize all institution email_domain values (trim whitespace, strip leading '@', lowercase)
-- and update admin_invite to compare against normalized email_domain.

UPDATE public.institutions
SET email_domain = lower(ltrim(btrim(email_domain), '@'))
WHERE email_domain <> lower(ltrim(btrim(email_domain), '@'));

CREATE OR REPLACE FUNCTION admin_invite(
  p_email text,
  p_role user_role,
  p_full_name text,
  p_institution_id uuid,
  p_school_id uuid DEFAULT NULL,
  p_department_id uuid DEFAULT NULL
)
RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_email text := lower(trim(coalesce(p_email, '')));
  v_name text := trim(coalesce(p_full_name, ''));
  v_domain text := split_part(v_email, '@', 2);
  v_inst_domain text;
  v_id uuid;
BEGIN
  IF NOT is_super_admin() THEN
    RAISE EXCEPTION 'forbidden';
  END IF;
  IF v_email = '' OR v_name = '' OR position('@' IN v_email) = 0 THEN
    RAISE EXCEPTION 'invalid_input';
  END IF;

  IF p_role <> 'super_admin' THEN
    SELECT lower(ltrim(btrim(email_domain), '@')) INTO v_inst_domain
    FROM public.institutions
    WHERE id = p_institution_id;

    IF v_inst_domain IS NULL THEN
      RAISE EXCEPTION 'institution_not_found';
    END IF;
    IF v_domain <> v_inst_domain THEN
      RAISE EXCEPTION 'domain_mismatch';
    END IF;
  END IF;

  IF EXISTS (SELECT 1 FROM public.profiles WHERE lower(email) = v_email)
     OR EXISTS (SELECT 1 FROM public.invites WHERE lower(email) = v_email) THEN
    RAISE EXCEPTION 'already_exists';
  END IF;

  INSERT INTO public.invites (
    email, institution_id, role, full_name, school_id, department_id, created_by
  )
  VALUES (
    v_email, p_institution_id, p_role, v_name, p_school_id, p_department_id, auth.uid()
  )
  RETURNING id INTO v_id;

  PERFORM public.audit(
    'invite_user',
    'invite',
    v_id::text,
    jsonb_build_object('email', v_email, 'role', p_role::text, 'full_name', v_name),
    p_institution_id
  );

  RETURN v_id;
END;
$$;
