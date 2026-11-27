-- Delete student-only accounts belonging to an institution when admin_remove_institution
-- removes that institution, after cleaning up courses, questions, and invites.

CREATE OR REPLACE FUNCTION admin_remove_institution(p_institution_id uuid)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_inst public.institutions%ROWTYPE;
  v_student_ids uuid[];
BEGIN
  IF NOT public.has_role('super_admin') THEN
    RAISE EXCEPTION 'forbidden';
  END IF;

  SELECT * INTO v_inst FROM public.institutions WHERE id = p_institution_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'not_found';
  END IF;

  SELECT COALESCE(array_agg(p.id), '{}')
  INTO v_student_ids
  FROM public.profiles p
  WHERE p.institution_id = p_institution_id
    AND p.role = 'student'
    AND NOT (
      COALESCE(p.roles, ARRAY[p.role]) && ARRAY[
        'super_admin'::user_role,
        'vc'::user_role,
        'coe'::user_role,
        'dean'::user_role,
        'hod'::user_role,
        'faculty'::user_role
      ]
    );

  DELETE FROM public.session_questions WHERE institution_id = p_institution_id;
  DELETE FROM public.questions WHERE institution_id = p_institution_id;
  DELETE FROM public.courses WHERE institution_id = p_institution_id;
  DELETE FROM public.invites WHERE institution_id = p_institution_id;

  IF cardinality(v_student_ids) > 0 THEN
    DELETE FROM auth.users WHERE id = ANY(v_student_ids);
  END IF;

  DELETE FROM public.institutions WHERE id = p_institution_id;

  PERFORM public.audit(
    'admin_remove_institution',
    'institution',
    p_institution_id::text,
    jsonb_build_object(
      'name', v_inst.name,
      'email_domain', v_inst.email_domain,
      'removed_students', cardinality(v_student_ids)
    ),
    NULL
  );
END;
$$;

REVOKE ALL ON FUNCTION admin_remove_institution(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION admin_remove_institution(uuid) TO authenticated;
