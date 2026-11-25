-- Ensure list_hierarchy_contacts resolves institution_id even if profile.institution_id is null
-- by falling back to the faculty member's courses.

DROP FUNCTION IF EXISTS list_hierarchy_contacts();

CREATE OR REPLACE FUNCTION list_hierarchy_contacts()
RETURNS TABLE (
  id uuid,
  full_name text,
  email text,
  role text,
  relation text
)
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_me public.profiles%ROWTYPE;
  v_inst uuid;
BEGIN
  SELECT * INTO v_me FROM public.profiles WHERE id = auth.uid() AND active = true;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'forbidden';
  END IF;

  v_inst := coalesce(
    v_me.institution_id,
    (SELECT c.institution_id FROM public.courses c WHERE c.faculty_id = v_me.id LIMIT 1)
  );

  RETURN QUERY
  SELECT DISTINCT ON (t.id, t.relation)
    t.id, t.full_name, t.email, t.role, t.relation
  FROM (
    -- Student -> Faculty of enrolled courses (request meeting)
    SELECT p.id, p.full_name, p.email, p.role, 'superior'::text AS relation
    FROM public.enrollments e
    JOIN public.courses c ON c.id = e.course_id
    JOIN public.profiles p ON p.id = c.faculty_id AND p.active = true
    WHERE public.has_role('student') AND e.student_id = v_me.id

    UNION ALL

    -- Faculty -> Any onboarded student enrolled in his class (notify / schedule meeting)
    SELECT p.id, p.full_name, p.email, p.role, 'subordinate'::text AS relation
    FROM public.courses c
    JOIN public.enrollments e ON e.course_id = c.id
    JOIN public.profiles p ON p.id = e.student_id AND p.active = true
    WHERE public.has_role('faculty') AND c.faculty_id = v_me.id

    UNION ALL

    -- Faculty -> HOD, Dean, CoE, VC/Principal (request meeting)
    SELECT p.id, p.full_name, p.email, p.role, 'superior'::text AS relation
    FROM public.profiles p
    WHERE public.has_role('faculty')
      AND p.active = true
      AND p.id <> v_me.id
      AND (v_inst IS NULL OR p.institution_id = v_inst)
      AND (
        ('hod' = ANY(CASE WHEN cardinality(p.roles) > 0 THEN p.roles ELSE ARRAY[p.role] END)
          AND (v_me.department_id IS NULL OR p.department_id IS NULL OR p.department_id = v_me.department_id))
        OR ('dean' = ANY(CASE WHEN cardinality(p.roles) > 0 THEN p.roles ELSE ARRAY[p.role] END)
          AND (v_me.school_id IS NULL OR p.school_id IS NULL OR p.school_id = v_me.school_id))
        OR 'coe' = ANY(CASE WHEN cardinality(p.roles) > 0 THEN p.roles ELSE ARRAY[p.role] END)
        OR 'vc' = ANY(CASE WHEN cardinality(p.roles) > 0 THEN p.roles ELSE ARRAY[p.role] END)
      )

    UNION ALL

    -- HOD -> Faculty in department (notify / schedule meeting)
    SELECT p.id, p.full_name, p.email, p.role, 'subordinate'::text AS relation
    FROM public.profiles p
    WHERE public.has_role('hod')
      AND p.active = true
      AND p.id <> v_me.id
      AND (v_inst IS NULL OR p.institution_id = v_inst)
      AND (v_me.department_id IS NULL OR p.department_id IS NULL OR p.department_id = v_me.department_id)
      AND 'faculty' = ANY(CASE WHEN cardinality(p.roles) > 0 THEN p.roles ELSE ARRAY[p.role] END)

    UNION ALL

    -- HOD -> Dean, CoE, VC (request meeting)
    SELECT p.id, p.full_name, p.email, p.role, 'superior'::text AS relation
    FROM public.profiles p
    WHERE public.has_role('hod')
      AND p.active = true
      AND p.id <> v_me.id
      AND (v_inst IS NULL OR p.institution_id = v_inst)
      AND (
        ('dean' = ANY(CASE WHEN cardinality(p.roles) > 0 THEN p.roles ELSE ARRAY[p.role] END)
          AND (v_me.school_id IS NULL OR p.school_id IS NULL OR p.school_id = v_me.school_id))
        OR 'coe' = ANY(CASE WHEN cardinality(p.roles) > 0 THEN p.roles ELSE ARRAY[p.role] END)
        OR 'vc' = ANY(CASE WHEN cardinality(p.roles) > 0 THEN p.roles ELSE ARRAY[p.role] END)
      )

    UNION ALL

    -- Dean -> HODs in school (notify / schedule meeting)
    SELECT p.id, p.full_name, p.email, p.role, 'subordinate'::text AS relation
    FROM public.profiles p
    WHERE public.has_role('dean')
      AND p.active = true
      AND p.id <> v_me.id
      AND (v_inst IS NULL OR p.institution_id = v_inst)
      AND (v_me.school_id IS NULL OR p.school_id IS NULL OR p.school_id = v_me.school_id)
      AND 'hod' = ANY(CASE WHEN cardinality(p.roles) > 0 THEN p.roles ELSE ARRAY[p.role] END)

    UNION ALL

    -- CoE -> Deans in institution (notify / schedule meeting)
    SELECT p.id, p.full_name, p.email, p.role, 'subordinate'::text AS relation
    FROM public.profiles p
    WHERE public.has_role('coe')
      AND p.active = true
      AND p.id <> v_me.id
      AND (v_inst IS NULL OR p.institution_id = v_inst)
      AND 'dean' = ANY(CASE WHEN cardinality(p.roles) > 0 THEN p.roles ELSE ARRAY[p.role] END)

    UNION ALL

    -- VC -> Everybody in institution except students (notify / schedule meeting)
    SELECT p.id, p.full_name, p.email, p.role, 'subordinate'::text AS relation
    FROM public.profiles p
    WHERE public.has_role('vc')
      AND p.active = true
      AND p.id <> v_me.id
      AND (v_inst IS NULL OR p.institution_id = v_inst)
      AND p.role <> 'student'
      AND NOT ('student' = ANY(CASE WHEN cardinality(p.roles) > 0 THEN p.roles ELSE ARRAY[p.role] END))
  ) t
  ORDER BY t.id, t.relation;
END;
$$;

GRANT EXECUTE ON FUNCTION list_hierarchy_contacts() TO authenticated;
