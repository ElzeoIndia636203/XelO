-- Multi-role support on profiles (preserving existing data and primary role compatibility).

ALTER TABLE public.profiles
  ADD COLUMN IF NOT EXISTS roles user_role[] NOT NULL DEFAULT '{}'::user_role[];

UPDATE public.profiles
SET roles = ARRAY[role]
WHERE cardinality(roles) = 0;

CREATE OR REPLACE FUNCTION effective_roles(p_user_id uuid DEFAULT auth.uid())
RETURNS user_role[]
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT COALESCE(
    (
      SELECT CASE
        WHEN cardinality(p.roles) > 0 THEN p.roles
        ELSE ARRAY[p.role]
      END
      FROM public.profiles p
      WHERE p.id = p_user_id AND p.active = true
    ),
    '{}'::user_role[]
  );
$$;

CREATE OR REPLACE FUNCTION has_role(p_role user_role, p_user_id uuid DEFAULT auth.uid())
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT p_role = ANY(public.effective_roles(p_user_id));
$$;

-- Extend course faculty & oversight checks to respect multi-role assignments.
CREATE OR REPLACE FUNCTION is_course_faculty(c uuid)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT EXISTS (
    SELECT 1
    FROM public.courses co
    WHERE co.id = c
      AND co.faculty_id = auth.uid()
      AND (public.has_role('faculty') OR public.has_role('hod'))
  );
$$;

CREATE OR REPLACE FUNCTION can_oversee_course(c uuid)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT EXISTS (
    SELECT 1
    FROM public.courses co
    JOIN public.profiles p ON p.id = auth.uid()
    WHERE co.id = c
      AND p.active = true
      AND (
        public.has_role('super_admin')
        OR (
          co.institution_id = p.institution_id
          AND (
            public.has_role('vc')
            OR public.has_role('coe')
            OR (
              public.has_role('dean')
              AND EXISTS (
                SELECT 1 FROM public.departments d
                WHERE d.id = co.department_id AND d.school_id = p.school_id
              )
            )
            OR (public.has_role('hod') AND co.department_id = p.department_id)
          )
        )
      )
  );
$$;

CREATE OR REPLACE FUNCTION admin_assign_roles(
  p_user_id uuid,
  p_roles user_role[],
  p_institution_id uuid DEFAULT NULL,
  p_school_id uuid DEFAULT NULL,
  p_department_id uuid DEFAULT NULL
)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_prof public.profiles%ROWTYPE;
  v_clean user_role[];
  v_primary user_role;
BEGIN
  IF NOT is_super_admin() THEN
    RAISE EXCEPTION 'forbidden';
  END IF;

  SELECT ARRAY(
    SELECT DISTINCT r
    FROM unnest(COALESCE(p_roles, '{}'::user_role[])) AS r
  ) INTO v_clean;

  IF cardinality(v_clean) = 0 THEN
    RAISE EXCEPTION 'invalid_input';
  END IF;

  SELECT * INTO v_prof FROM public.profiles WHERE id = p_user_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'not_found';
  END IF;

  -- Protect super-admin hierarchy if removing super_admin role from a protected account.
  IF v_prof.role = 'super_admin' AND NOT ('super_admin' = ANY(v_clean)) THEN
    PERFORM public.assert_can_modify_super_admin_target(auth.uid(), v_prof.email);
  END IF;

  v_primary := CASE
    WHEN 'super_admin' = ANY(v_clean) THEN 'super_admin'::user_role
    WHEN 'vc' = ANY(v_clean) THEN 'vc'::user_role
    WHEN 'coe' = ANY(v_clean) THEN 'coe'::user_role
    WHEN 'dean' = ANY(v_clean) THEN 'dean'::user_role
    WHEN 'hod' = ANY(v_clean) THEN 'hod'::user_role
    WHEN 'faculty' = ANY(v_clean) THEN 'faculty'::user_role
    ELSE 'student'::user_role
  END;

  UPDATE public.profiles
  SET role = v_primary,
      roles = v_clean,
      institution_id = COALESCE(p_institution_id, institution_id),
      school_id = COALESCE(p_school_id, school_id),
      department_id = COALESCE(p_department_id, department_id)
  WHERE id = p_user_id;

  PERFORM public.audit(
    'assign_roles',
    'profile',
    p_user_id::text,
    jsonb_build_object('email', v_prof.email, 'primary_role', v_primary::text, 'roles', v_clean),
    COALESCE(p_institution_id, v_prof.institution_id)
  );
END;
$$;

GRANT EXECUTE ON FUNCTION effective_roles(uuid), has_role(user_role, uuid), admin_assign_roles(uuid, user_role[], uuid, uuid, uuid) TO authenticated;
