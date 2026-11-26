-- Role-scoped department/school assignments and HOD-to-faculty grouping.
-- Allows a user with multiple roles (e.g. faculty of Dept A + HOD of Dept B)
-- to hold an explicit HOD department (hod_department_id) and Dean school (dean_school_id)
-- without assuming they match their faculty department/school.

ALTER TABLE public.profiles
  ADD COLUMN IF NOT EXISTS hod_department_id uuid REFERENCES public.departments(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS dean_school_id uuid REFERENCES public.schools(id) ON DELETE SET NULL;

-- Backfill existing HOD / Dean users so existing setups remain intact.
UPDATE public.profiles
SET hod_department_id = department_id
WHERE 'hod' = ANY(CASE WHEN cardinality(roles) > 0 THEN roles ELSE ARRAY[role] END)
  AND department_id IS NOT NULL
  AND hod_department_id IS NULL;

UPDATE public.profiles
SET dean_school_id = school_id
WHERE 'dean' = ANY(CASE WHEN cardinality(roles) > 0 THEN roles ELSE ARRAY[role] END)
  AND school_id IS NOT NULL
  AND dean_school_id IS NULL;

CREATE OR REPLACE FUNCTION my_hod_department()
RETURNS uuid
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT COALESCE(hod_department_id, department_id)
  FROM public.profiles
  WHERE id = auth.uid();
$$;

CREATE OR REPLACE FUNCTION my_dean_school()
RETURNS uuid
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT COALESCE(dean_school_id, school_id)
  FROM public.profiles
  WHERE id = auth.uid();
$$;

-- Existing HOD workflow checks call my_department(); route it to HOD department when acting as HOD.
CREATE OR REPLACE FUNCTION my_department()
RETURNS uuid
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT CASE
    WHEN public.has_role('hod') THEN COALESCE(hod_department_id, department_id)
    ELSE department_id
  END
  FROM public.profiles
  WHERE id = auth.uid();
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
                WHERE d.id = co.department_id
                  AND d.school_id = COALESCE(p.dean_school_id, p.school_id)
              )
            )
            OR (public.has_role('hod') AND co.department_id = COALESCE(p.hod_department_id, p.department_id))
          )
        )
      )
  );
$$;

-- Update department_outcomes RLS policies so HOD manages outcomes for my_hod_department().
DROP POLICY IF EXISTS dept_outcomes_insert ON department_outcomes;
DROP POLICY IF EXISTS dept_outcomes_update ON department_outcomes;
DROP POLICY IF EXISTS dept_outcomes_delete ON department_outcomes;

CREATE POLICY dept_outcomes_insert ON department_outcomes
  FOR INSERT TO authenticated
  WITH CHECK (
    has_role('super_admin')
    OR (
      has_role('hod')
      AND institution_id = my_institution()
      AND department_id = my_hod_department()
    )
  );

CREATE POLICY dept_outcomes_update ON department_outcomes
  FOR UPDATE TO authenticated
  USING (
    has_role('super_admin')
    OR (
      has_role('hod')
      AND institution_id = my_institution()
      AND department_id = my_hod_department()
    )
  )
  WITH CHECK (
    has_role('super_admin')
    OR (
      has_role('hod')
      AND institution_id = my_institution()
      AND department_id = my_hod_department()
    )
  );

CREATE POLICY dept_outcomes_delete ON department_outcomes
  FOR DELETE TO authenticated
  USING (
    has_role('super_admin')
    OR (
      has_role('hod')
      AND institution_id = my_institution()
      AND department_id = my_hod_department()
    )
  );

-- Update academic_calendars & academic_calendar_events RLS so HOD manages calendar for my_hod_department().
DROP POLICY IF EXISTS ac_cal_insert ON academic_calendars;
DROP POLICY IF EXISTS ac_cal_update ON academic_calendars;
DROP POLICY IF EXISTS ac_cal_delete ON academic_calendars;

CREATE POLICY ac_cal_insert ON academic_calendars
  FOR INSERT TO authenticated
  WITH CHECK (
    has_role('super_admin')
    OR (
      has_role('hod')
      AND institution_id = my_institution()
      AND department_id = my_hod_department()
    )
  );

CREATE POLICY ac_cal_update ON academic_calendars
  FOR UPDATE TO authenticated
  USING (
    has_role('super_admin')
    OR (
      has_role('hod')
      AND institution_id = my_institution()
      AND department_id = my_hod_department()
    )
  )
  WITH CHECK (
    has_role('super_admin')
    OR (
      has_role('hod')
      AND institution_id = my_institution()
      AND department_id = my_hod_department()
    )
  );

CREATE POLICY ac_cal_delete ON academic_calendars
  FOR DELETE TO authenticated
  USING (
    has_role('super_admin')
    OR (
      has_role('hod')
      AND institution_id = my_institution()
      AND department_id = my_hod_department()
    )
  );

DROP POLICY IF EXISTS ac_cal_ev_insert ON academic_calendar_events;
DROP POLICY IF EXISTS ac_cal_ev_update ON academic_calendar_events;
DROP POLICY IF EXISTS ac_cal_ev_delete ON academic_calendar_events;

CREATE POLICY ac_cal_ev_insert ON academic_calendar_events
  FOR INSERT TO authenticated
  WITH CHECK (
    has_role('super_admin')
    OR (
      has_role('hod')
      AND institution_id = my_institution()
      AND department_id = my_hod_department()
    )
  );

CREATE POLICY ac_cal_ev_update ON academic_calendar_events
  FOR UPDATE TO authenticated
  USING (
    has_role('super_admin')
    OR (
      has_role('hod')
      AND institution_id = my_institution()
      AND department_id = my_hod_department()
    )
  )
  WITH CHECK (
    has_role('super_admin')
    OR (
      has_role('hod')
      AND institution_id = my_institution()
      AND department_id = my_hod_department()
    )
  );

CREATE POLICY ac_cal_ev_delete ON academic_calendar_events
  FOR DELETE TO authenticated
  USING (
    has_role('super_admin')
    OR (
      has_role('hod')
      AND institution_id = my_institution()
      AND department_id = my_hod_department()
    )
  );

-- Extend admin_assign_roles with optional role-specific HOD department and Dean school.
DROP FUNCTION IF EXISTS admin_assign_roles(uuid, user_role[], uuid, uuid, uuid);

CREATE OR REPLACE FUNCTION admin_assign_roles(
  p_user_id uuid,
  p_roles user_role[],
  p_institution_id uuid DEFAULT NULL,
  p_school_id uuid DEFAULT NULL,
  p_department_id uuid DEFAULT NULL,
  p_hod_department_id uuid DEFAULT NULL,
  p_dean_school_id uuid DEFAULT NULL
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
  v_inst uuid;
  v_school uuid;
  v_dept uuid;
  v_hod_dept uuid;
  v_dean_school uuid;
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

  IF v_prof.role = 'super_admin' AND NOT ('super_admin' = ANY(v_clean)) THEN
    PERFORM public.assert_can_modify_super_admin_target(auth.uid(), v_prof.email);
  END IF;

  v_inst := COALESCE(p_institution_id, v_prof.institution_id);

  IF 'hod' = ANY(v_clean) THEN
    v_hod_dept := COALESCE(p_hod_department_id, p_department_id, v_prof.hod_department_id, v_prof.department_id);
    IF v_hod_dept IS NULL THEN
      RAISE EXCEPTION 'department_required';
    END IF;
    IF v_inst IS NOT NULL AND NOT EXISTS (
      SELECT 1 FROM public.departments d WHERE d.id = v_hod_dept AND d.institution_id = v_inst
    ) THEN
      RAISE EXCEPTION 'invalid_scope';
    END IF;
  ELSE
    v_hod_dept := NULL;
  END IF;

  IF 'dean' = ANY(v_clean) THEN
    v_dean_school := COALESCE(p_dean_school_id, p_school_id, v_prof.dean_school_id, v_prof.school_id);
    IF v_dean_school IS NULL THEN
      RAISE EXCEPTION 'school_required';
    END IF;
    IF v_inst IS NOT NULL AND NOT EXISTS (
      SELECT 1 FROM public.schools s WHERE s.id = v_dean_school AND s.institution_id = v_inst
    ) THEN
      RAISE EXCEPTION 'invalid_scope';
    END IF;
  ELSE
    v_dean_school := NULL;
  END IF;

  v_dept := COALESCE(p_department_id, v_prof.department_id, v_hod_dept);
  v_school := COALESCE(p_school_id, v_prof.school_id, v_dean_school);

  IF v_school IS NULL AND v_dept IS NOT NULL THEN
    SELECT d.school_id INTO v_school FROM public.departments d WHERE d.id = v_dept;
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
      institution_id = v_inst,
      school_id = v_school,
      department_id = v_dept,
      hod_department_id = v_hod_dept,
      dean_school_id = v_dean_school
  WHERE id = p_user_id;

  -- Keep departments.hod_id and schools.dean_id grouped with this user.
  UPDATE public.departments
  SET hod_id = NULL
  WHERE hod_id = p_user_id
    AND (v_hod_dept IS NULL OR id <> v_hod_dept);

  IF v_hod_dept IS NOT NULL THEN
    UPDATE public.departments
    SET hod_id = p_user_id
    WHERE id = v_hod_dept;
  END IF;

  UPDATE public.schools
  SET dean_id = NULL
  WHERE dean_id = p_user_id
    AND (v_dean_school IS NULL OR id <> v_dean_school);

  IF v_dean_school IS NOT NULL THEN
    UPDATE public.schools
    SET dean_id = p_user_id
    WHERE id = v_dean_school;
  END IF;

  PERFORM public.audit(
    'assign_roles',
    'profile',
    p_user_id::text,
    jsonb_build_object(
      'email', v_prof.email,
      'primary_role', v_primary::text,
      'roles', v_clean,
      'department_id', v_dept,
      'hod_department_id', v_hod_dept,
      'dean_school_id', v_dean_school
    ),
    v_inst
  );
END;
$$;

-- Update hod_faculty_summary to group faculties under the HOD's finalized department
-- and show all courses handled by those faculties (plus any course in that department).
CREATE OR REPLACE FUNCTION hod_faculty_summary(p_department_id uuid DEFAULT NULL)
RETURNS TABLE (
  faculty_id uuid,
  faculty_name text,
  faculty_email text,
  course_id uuid,
  course_code text,
  course_title text,
  sessions_total integer,
  sessions_conducted integer,
  missed_classes integer,
  streak integer,
  attendance_pct numeric,
  avg_score_pct numeric
)
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_me public.profiles%ROWTYPE;
  v_dept uuid;
BEGIN
  SELECT * INTO v_me FROM public.profiles WHERE id = auth.uid() AND active = true;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'forbidden';
  END IF;

  IF NOT (
    public.has_role('hod')
    OR public.has_role('dean')
    OR public.has_role('coe')
    OR public.has_role('vc')
    OR public.has_role('super_admin')
  ) THEN
    RAISE EXCEPTION 'forbidden';
  END IF;

  v_dept := COALESCE(p_department_id, COALESCE(v_me.hod_department_id, v_me.department_id));

  RETURN QUERY
  SELECT
    p.id AS faculty_id,
    p.full_name AS faculty_name,
    p.email AS faculty_email,
    c.id AS course_id,
    COALESCE(c.code, '—') AS course_code,
    COALESCE(c.title, 'No courses assigned yet') AS course_title,
    CASE WHEN c.id IS NULL THEN 0 ELSE (SELECT count(*)::integer FROM public.sessions s WHERE s.course_id = c.id) END AS sessions_total,
    CASE WHEN c.id IS NULL THEN 0 ELSE (SELECT count(*)::integer FROM public.sessions s WHERE s.course_id = c.id AND s.status = 'conducted') END AS sessions_conducted,
    CASE WHEN c.id IS NULL THEN 0 ELSE (
      SELECT count(*)::integer FROM public.sessions s
      WHERE s.course_id = c.id
        AND s.scheduled_date IS NOT NULL
        AND s.scheduled_date < (now() AT TIME ZONE 'Asia/Kolkata')::date
        AND s.status <> 'conducted'
    ) END AS missed_classes,
    CASE WHEN c.id IS NULL THEN 0 ELSE COALESCE((
      SELECT count(*)::integer
      FROM public.sessions s
      WHERE s.course_id = c.id
        AND s.status = 'conducted'
        AND s.n > COALESCE((
          SELECT max(s2.n)
          FROM public.sessions s2
          WHERE s2.course_id = c.id
            AND s2.scheduled_date IS NOT NULL
            AND s2.scheduled_date < (now() AT TIME ZONE 'Asia/Kolkata')::date
            AND s2.status <> 'conducted'
        ), 0)
    ), 0) END AS streak,
    CASE WHEN c.id IS NULL THEN 0::numeric ELSE COALESCE((
      SELECT round(100.0 * count(*) FILTER (WHERE a.status IN ('present', 'late')) / NULLIF(count(*), 0), 1)
      FROM public.attendance a
      JOIN public.sessions s ON s.id = a.session_id
      WHERE s.course_id = c.id
    ), 0)::numeric END AS attendance_pct,
    CASE WHEN c.id IS NULL THEN 0::numeric ELSE COALESCE((
      SELECT round(avg(CASE WHEN sub.passed THEN 100.0 ELSE 0.0 END), 1)
      FROM public.submissions sub
      JOIN public.sessions s ON s.id = sub.session_id
      WHERE s.course_id = c.id AND sub.mode = 'submit'
    ), 0)::numeric END AS avg_score_pct
  FROM public.profiles p
  LEFT JOIN public.courses c ON c.faculty_id = p.id
  WHERE p.active = true
    AND (public.has_role('super_admin') OR p.institution_id = v_me.institution_id)
    AND (
      (v_dept IS NOT NULL AND c.department_id = v_dept)
      OR (
        (v_dept IS NULL OR p.department_id = v_dept)
        AND 'faculty' = ANY(CASE WHEN cardinality(p.roles) > 0 THEN p.roles ELSE ARRAY[p.role] END)
      )
    )
  ORDER BY p.full_name, c.code NULLS LAST;
END;
$$;

-- Update list_hierarchy_contacts to respect hod_department_id and dean_school_id.
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

  IF public.has_role('faculty') AND NOT (public.has_role('hod') OR public.has_role('dean') OR public.has_role('coe') OR public.has_role('vc')) THEN
    RETURN QUERY
    SELECT p.id, p.full_name, p.email,
      CASE
        WHEN 'vc' = ANY(CASE WHEN cardinality(p.roles) > 0 THEN p.roles ELSE ARRAY[p.role] END) THEN 'vc'
        WHEN 'coe' = ANY(CASE WHEN cardinality(p.roles) > 0 THEN p.roles ELSE ARRAY[p.role] END) THEN 'coe'
        WHEN 'dean' = ANY(CASE WHEN cardinality(p.roles) > 0 THEN p.roles ELSE ARRAY[p.role] END) THEN 'dean'
        ELSE 'hod'
      END,
      CASE
        WHEN 'vc' = ANY(CASE WHEN cardinality(p.roles) > 0 THEN p.roles ELSE ARRAY[p.role] END) THEN 'VC'
        WHEN 'coe' = ANY(CASE WHEN cardinality(p.roles) > 0 THEN p.roles ELSE ARRAY[p.role] END) THEN 'CoE'
        WHEN 'dean' = ANY(CASE WHEN cardinality(p.roles) > 0 THEN p.roles ELSE ARRAY[p.role] END) THEN 'Dean'
        ELSE 'HOD'
      END
    FROM public.profiles p
    WHERE p.active = true
      AND p.institution_id = v_inst
      AND p.id <> v_me.id
      AND (
        ('hod' = ANY(CASE WHEN cardinality(p.roles) > 0 THEN p.roles ELSE ARRAY[p.role] END)
          AND (v_me.department_id IS NULL OR COALESCE(p.hod_department_id, p.department_id) = v_me.department_id))
        OR ('dean' = ANY(CASE WHEN cardinality(p.roles) > 0 THEN p.roles ELSE ARRAY[p.role] END)
          AND (v_me.school_id IS NULL OR COALESCE(p.dean_school_id, p.school_id) IS NULL OR COALESCE(p.dean_school_id, p.school_id) = v_me.school_id))
        OR 'coe' = ANY(CASE WHEN cardinality(p.roles) > 0 THEN p.roles ELSE ARRAY[p.role] END)
        OR 'vc' = ANY(CASE WHEN cardinality(p.roles) > 0 THEN p.roles ELSE ARRAY[p.role] END)
      )
    ORDER BY p.full_name;
    RETURN;
  END IF;

  IF public.has_role('hod') AND NOT (public.has_role('dean') OR public.has_role('coe') OR public.has_role('vc')) THEN
    RETURN QUERY
    SELECT p.id, p.full_name, p.email, 'faculty'::text, 'Faculty'::text
    FROM public.profiles p
    WHERE p.active = true
      AND p.institution_id = v_inst
      AND p.id <> v_me.id
      AND (v_hod_dept IS NULL OR p.department_id IS NULL OR p.department_id = v_hod_dept)
      AND 'faculty' = ANY(CASE WHEN cardinality(p.roles) > 0 THEN p.roles ELSE ARRAY[p.role] END)
    UNION ALL
    SELECT p.id, p.full_name, p.email,
      CASE
        WHEN 'vc' = ANY(CASE WHEN cardinality(p.roles) > 0 THEN p.roles ELSE ARRAY[p.role] END) THEN 'vc'
        WHEN 'coe' = ANY(CASE WHEN cardinality(p.roles) > 0 THEN p.roles ELSE ARRAY[p.role] END) THEN 'coe'
        ELSE 'dean'
      END,
      CASE
        WHEN 'vc' = ANY(CASE WHEN cardinality(p.roles) > 0 THEN p.roles ELSE ARRAY[p.role] END) THEN 'VC'
        WHEN 'coe' = ANY(CASE WHEN cardinality(p.roles) > 0 THEN p.roles ELSE ARRAY[p.role] END) THEN 'CoE'
        ELSE 'Dean'
      END
    FROM public.profiles p
    WHERE p.active = true
      AND p.institution_id = v_inst
      AND p.id <> v_me.id
      AND (
        ('dean' = ANY(CASE WHEN cardinality(p.roles) > 0 THEN p.roles ELSE ARRAY[p.role] END)
          AND (v_me.school_id IS NULL OR COALESCE(p.dean_school_id, p.school_id) IS NULL OR COALESCE(p.dean_school_id, p.school_id) = v_me.school_id))
        OR 'coe' = ANY(CASE WHEN cardinality(p.roles) > 0 THEN p.roles ELSE ARRAY[p.role] END)
        OR 'vc' = ANY(CASE WHEN cardinality(p.roles) > 0 THEN p.roles ELSE ARRAY[p.role] END)
      )
    ORDER BY 5, 2;
    RETURN;
  END IF;

  IF public.has_role('dean') AND NOT (public.has_role('coe') OR public.has_role('vc')) THEN
    RETURN QUERY
    SELECT p.id, p.full_name, p.email, 'hod'::text, 'HOD'::text
    FROM public.profiles p
    WHERE p.active = true
      AND p.institution_id = v_inst
      AND p.id <> v_me.id
      AND (
        v_dean_school IS NULL
        OR EXISTS (
          SELECT 1 FROM public.departments d
          WHERE d.id = COALESCE(p.hod_department_id, p.department_id)
            AND d.school_id = v_dean_school
        )
      )
      AND 'hod' = ANY(CASE WHEN cardinality(p.roles) > 0 THEN p.roles ELSE ARRAY[p.role] END)
    UNION ALL
    SELECT p.id, p.full_name, p.email,
      CASE WHEN 'vc' = ANY(CASE WHEN cardinality(p.roles) > 0 THEN p.roles ELSE ARRAY[p.role] END) THEN 'vc' ELSE 'coe' END,
      CASE WHEN 'vc' = ANY(CASE WHEN cardinality(p.roles) > 0 THEN p.roles ELSE ARRAY[p.role] END) THEN 'VC' ELSE 'CoE' END
    FROM public.profiles p
    WHERE p.active = true
      AND p.institution_id = v_inst
      AND p.id <> v_me.id
      AND (
        'coe' = ANY(CASE WHEN cardinality(p.roles) > 0 THEN p.roles ELSE ARRAY[p.role] END)
        OR 'vc' = ANY(CASE WHEN cardinality(p.roles) > 0 THEN p.roles ELSE ARRAY[p.role] END)
      )
    ORDER BY 5, 2;
    RETURN;
  END IF;

  IF public.has_role('coe') OR public.has_role('vc') OR public.has_role('super_admin') THEN
    RETURN QUERY
    SELECT p.id, p.full_name, p.email, p.role::text,
      initcap(replace(p.role::text, '_', ' '))
    FROM public.profiles p
    WHERE p.active = true
      AND (public.has_role('super_admin') OR p.institution_id = v_inst)
      AND p.id <> v_me.id
      AND NOT ('student' = ANY(CASE WHEN cardinality(p.roles) > 0 THEN p.roles ELSE ARRAY[p.role] END))
    ORDER BY p.full_name;
    RETURN;
  END IF;
END;
$$;

GRANT EXECUTE ON FUNCTION list_hierarchy_contacts() TO authenticated;

GRANT EXECUTE ON FUNCTION my_hod_department(), my_dean_school(), admin_assign_roles(uuid, user_role[], uuid, uuid, uuid, uuid, uuid) TO authenticated;
