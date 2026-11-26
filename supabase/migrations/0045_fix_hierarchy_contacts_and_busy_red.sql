-- Fix list_hierarchy_contacts so:
-- 1. Faculty Request meeting ('superior') loads HOD, Dean, CoE, VC in institution.
-- 2. HOD Request meeting ('superior') loads Dean, CoE, VC in institution.
-- 3. Schedule meeting ('subordinate') loads lower hierarchy (HOD -> Faculty, Faculty -> Students, Dean -> HOD/Faculty, CoE -> Dean/HOD/Faculty, VC -> all staff).

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
  v_hod_dept uuid;
  v_dean_school uuid;
BEGIN
  SELECT * INTO v_me FROM public.profiles WHERE id = auth.uid() AND active = true;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'forbidden';
  END IF;

  v_inst := coalesce(
    v_me.institution_id,
    (SELECT c.institution_id FROM public.courses c WHERE c.faculty_id = v_me.id LIMIT 1)
  );
  v_hod_dept := COALESCE(v_me.hod_department_id, v_me.department_id);
  v_dean_school := COALESCE(v_me.dean_school_id, v_me.school_id);

  RETURN QUERY
  SELECT DISTINCT ON (t.id, t.relation)
    t.id, t.full_name, t.email, t.role, t.relation
  FROM (
    -- Student -> Faculty of enrolled courses (request meeting)
    SELECT p.id, p.full_name, p.email, 'faculty'::text AS role, 'superior'::text AS relation
    FROM public.enrollments e
    JOIN public.courses c ON c.id = e.course_id
    JOIN public.profiles p ON p.id = c.faculty_id AND p.active = true
    WHERE public.has_role('student') AND e.student_id = v_me.id

    UNION ALL

    -- Faculty -> Enrolled students (schedule meeting / notify)
    SELECT p.id, p.full_name, p.email, 'student'::text AS role, 'subordinate'::text AS relation
    FROM public.courses c
    JOIN public.enrollments e ON e.course_id = c.id
    JOIN public.profiles p ON p.id = e.student_id AND p.active = true
    WHERE public.has_role('faculty') AND c.faculty_id = v_me.id

    UNION ALL

    -- Faculty -> HOD, Dean, CoE, VC in institution (request meeting)
    SELECT p.id, p.full_name, p.email,
      CASE
        WHEN 'vc' = ANY(CASE WHEN cardinality(p.roles) > 0 THEN p.roles ELSE ARRAY[p.role] END) THEN 'vc'
        WHEN 'coe' = ANY(CASE WHEN cardinality(p.roles) > 0 THEN p.roles ELSE ARRAY[p.role] END) THEN 'coe'
        WHEN 'dean' = ANY(CASE WHEN cardinality(p.roles) > 0 THEN p.roles ELSE ARRAY[p.role] END) THEN 'dean'
        ELSE 'hod'
      END AS role,
      'superior'::text AS relation
    FROM public.profiles p
    WHERE public.has_role('faculty')
      AND p.active = true
      AND p.id <> v_me.id
      AND (v_inst IS NULL OR p.institution_id = v_inst)
      AND (
        ('hod' = ANY(CASE WHEN cardinality(p.roles) > 0 THEN p.roles ELSE ARRAY[p.role] END)
          AND (v_me.department_id IS NULL OR COALESCE(p.hod_department_id, p.department_id) IS NULL OR COALESCE(p.hod_department_id, p.department_id) = v_me.department_id))
        OR 'dean' = ANY(CASE WHEN cardinality(p.roles) > 0 THEN p.roles ELSE ARRAY[p.role] END)
        OR 'coe' = ANY(CASE WHEN cardinality(p.roles) > 0 THEN p.roles ELSE ARRAY[p.role] END)
        OR 'vc' = ANY(CASE WHEN cardinality(p.roles) > 0 THEN p.roles ELSE ARRAY[p.role] END)
      )

    UNION ALL

    -- HOD -> Faculties in department (schedule meeting / notify)
    SELECT p.id, p.full_name, p.email, 'faculty'::text AS role, 'subordinate'::text AS relation
    FROM public.profiles p
    WHERE public.has_role('hod')
      AND p.active = true
      AND p.id <> v_me.id
      AND (v_inst IS NULL OR p.institution_id = v_inst)
      AND (v_hod_dept IS NULL OR p.department_id IS NULL OR p.department_id = v_hod_dept)
      AND 'faculty' = ANY(CASE WHEN cardinality(p.roles) > 0 THEN p.roles ELSE ARRAY[p.role] END)

    UNION ALL

    -- HOD -> Dean, CoE, VC in institution (request meeting)
    SELECT p.id, p.full_name, p.email,
      CASE
        WHEN 'vc' = ANY(CASE WHEN cardinality(p.roles) > 0 THEN p.roles ELSE ARRAY[p.role] END) THEN 'vc'
        WHEN 'coe' = ANY(CASE WHEN cardinality(p.roles) > 0 THEN p.roles ELSE ARRAY[p.role] END) THEN 'coe'
        ELSE 'dean'
      END AS role,
      'superior'::text AS relation
    FROM public.profiles p
    WHERE public.has_role('hod')
      AND p.active = true
      AND p.id <> v_me.id
      AND (v_inst IS NULL OR p.institution_id = v_inst)
      AND (
        'dean' = ANY(CASE WHEN cardinality(p.roles) > 0 THEN p.roles ELSE ARRAY[p.role] END)
        OR 'coe' = ANY(CASE WHEN cardinality(p.roles) > 0 THEN p.roles ELSE ARRAY[p.role] END)
        OR 'vc' = ANY(CASE WHEN cardinality(p.roles) > 0 THEN p.roles ELSE ARRAY[p.role] END)
      )

    UNION ALL

    -- Dean -> HODs & Faculties in school/institution (schedule meeting / notify)
    SELECT p.id, p.full_name, p.email,
      CASE
        WHEN 'hod' = ANY(CASE WHEN cardinality(p.roles) > 0 THEN p.roles ELSE ARRAY[p.role] END) THEN 'hod'
        ELSE 'faculty'
      END AS role,
      'subordinate'::text AS role_rel
    FROM public.profiles p
    WHERE public.has_role('dean')
      AND p.active = true
      AND p.id <> v_me.id
      AND (v_inst IS NULL OR p.institution_id = v_inst)
      AND (
        v_dean_school IS NULL
        OR p.school_id = v_dean_school
        OR EXISTS (
          SELECT 1 FROM public.departments d
          WHERE d.id = COALESCE(p.hod_department_id, p.department_id)
            AND d.school_id = v_dean_school
        )
      )
      AND (
        'hod' = ANY(CASE WHEN cardinality(p.roles) > 0 THEN p.roles ELSE ARRAY[p.role] END)
        OR 'faculty' = ANY(CASE WHEN cardinality(p.roles) > 0 THEN p.roles ELSE ARRAY[p.role] END)
      )

    UNION ALL

    -- Dean -> CoE, VC in institution (request meeting)
    SELECT p.id, p.full_name, p.email,
      CASE WHEN 'vc' = ANY(CASE WHEN cardinality(p.roles) > 0 THEN p.roles ELSE ARRAY[p.role] END) THEN 'vc' ELSE 'coe' END AS role,
      'superior'::text AS relation
    FROM public.profiles p
    WHERE public.has_role('dean')
      AND p.active = true
      AND p.id <> v_me.id
      AND (v_inst IS NULL OR p.institution_id = v_inst)
      AND (
        'coe' = ANY(CASE WHEN cardinality(p.roles) > 0 THEN p.roles ELSE ARRAY[p.role] END)
        OR 'vc' = ANY(CASE WHEN cardinality(p.roles) > 0 THEN p.roles ELSE ARRAY[p.role] END)
      )

    UNION ALL

    -- CoE -> Deans, HODs, Faculties in institution (schedule meeting / notify)
    SELECT p.id, p.full_name, p.email, p.role::text AS role, 'subordinate'::text AS relation
    FROM public.profiles p
    WHERE public.has_role('coe')
      AND p.active = true
      AND p.id <> v_me.id
      AND (v_inst IS NULL OR p.institution_id = v_inst)
      AND (
        'dean' = ANY(CASE WHEN cardinality(p.roles) > 0 THEN p.roles ELSE ARRAY[p.role] END)
        OR 'hod' = ANY(CASE WHEN cardinality(p.roles) > 0 THEN p.roles ELSE ARRAY[p.role] END)
        OR 'faculty' = ANY(CASE WHEN cardinality(p.roles) > 0 THEN p.roles ELSE ARRAY[p.role] END)
      )

    UNION ALL

    -- CoE -> VC in institution (request meeting)
    SELECT p.id, p.full_name, p.email, 'vc'::text AS role, 'superior'::text AS relation
    FROM public.profiles p
    WHERE public.has_role('coe')
      AND p.active = true
      AND p.id <> v_me.id
      AND (v_inst IS NULL OR p.institution_id = v_inst)
      AND 'vc' = ANY(CASE WHEN cardinality(p.roles) > 0 THEN p.roles ELSE ARRAY[p.role] END)

    UNION ALL

    -- VC -> Deans, CoE, HODs, Faculties in institution (schedule meeting / notify)
    SELECT p.id, p.full_name, p.email, p.role::text AS role, 'subordinate'::text AS relation
    FROM public.profiles p
    WHERE public.has_role('vc')
      AND p.active = true
      AND p.id <> v_me.id
      AND (v_inst IS NULL OR p.institution_id = v_inst)
      AND NOT ('student' = ANY(CASE WHEN cardinality(p.roles) > 0 THEN p.roles ELSE ARRAY[p.role] END))
  ) t
  ORDER BY t.id, t.relation, t.full_name;
END;
$$;

GRANT EXECUTE ON FUNCTION list_hierarchy_contacts() TO authenticated;
