-- Allow multi-role HODs (via has_role) to manage department_outcomes.

DROP POLICY IF EXISTS dept_outcomes_read ON department_outcomes;
DROP POLICY IF EXISTS dept_outcomes_insert ON department_outcomes;
DROP POLICY IF EXISTS dept_outcomes_update ON department_outcomes;
DROP POLICY IF EXISTS dept_outcomes_delete ON department_outcomes;

CREATE POLICY dept_outcomes_read ON department_outcomes
  FOR SELECT TO authenticated
  USING (has_role('super_admin') OR institution_id = my_institution());

CREATE POLICY dept_outcomes_insert ON department_outcomes
  FOR INSERT TO authenticated
  WITH CHECK (
    has_role('super_admin')
    OR (
      has_role('hod')
      AND institution_id = my_institution()
      AND department_id = (SELECT p.department_id FROM public.profiles p WHERE p.id = auth.uid())
    )
  );

CREATE POLICY dept_outcomes_update ON department_outcomes
  FOR UPDATE TO authenticated
  USING (
    has_role('super_admin')
    OR (
      has_role('hod')
      AND institution_id = my_institution()
      AND department_id = (SELECT p.department_id FROM public.profiles p WHERE p.id = auth.uid())
    )
  )
  WITH CHECK (
    has_role('super_admin')
    OR (
      has_role('hod')
      AND institution_id = my_institution()
      AND department_id = (SELECT p.department_id FROM public.profiles p WHERE p.id = auth.uid())
    )
  );

CREATE POLICY dept_outcomes_delete ON department_outcomes
  FOR DELETE TO authenticated
  USING (
    has_role('super_admin')
    OR (
      has_role('hod')
      AND institution_id = my_institution()
      AND department_id = (SELECT p.department_id FROM public.profiles p WHERE p.id = auth.uid())
    )
  );
