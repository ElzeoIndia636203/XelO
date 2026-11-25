-- Department-level PO and PSO registry managed by HOD and reflected in faculty CO-PO matrix.

CREATE TABLE department_outcomes (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  institution_id uuid NOT NULL REFERENCES institutions(id) ON DELETE CASCADE,
  department_id uuid NOT NULL REFERENCES departments(id) ON DELETE CASCADE,
  kind text NOT NULL CHECK (kind IN ('PO', 'PSO')),
  code text NOT NULL,
  statement text NOT NULL DEFAULT '',
  created_by uuid REFERENCES profiles(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (department_id, code)
);

CREATE INDEX idx_dept_outcomes_dept ON department_outcomes(department_id, kind, code);

ALTER TABLE department_outcomes ENABLE ROW LEVEL SECURITY;

GRANT SELECT, INSERT, UPDATE, DELETE ON department_outcomes TO authenticated;
GRANT ALL ON department_outcomes TO service_role;

CREATE POLICY dept_outcomes_read ON department_outcomes
  FOR SELECT TO authenticated
  USING (is_super_admin() OR institution_id = my_institution());

CREATE POLICY dept_outcomes_insert ON department_outcomes
  FOR INSERT TO authenticated
  WITH CHECK (
    is_super_admin()
    OR (
      my_role() = 'hod'
      AND institution_id = my_institution()
      AND department_id = (SELECT p.department_id FROM public.profiles p WHERE p.id = auth.uid())
    )
  );

CREATE POLICY dept_outcomes_update ON department_outcomes
  FOR UPDATE TO authenticated
  USING (
    is_super_admin()
    OR (
      my_role() = 'hod'
      AND institution_id = my_institution()
      AND department_id = (SELECT p.department_id FROM public.profiles p WHERE p.id = auth.uid())
    )
  )
  WITH CHECK (
    is_super_admin()
    OR (
      my_role() = 'hod'
      AND institution_id = my_institution()
      AND department_id = (SELECT p.department_id FROM public.profiles p WHERE p.id = auth.uid())
    )
  );

CREATE POLICY dept_outcomes_delete ON department_outcomes
  FOR DELETE TO authenticated
  USING (
    is_super_admin()
    OR (
      my_role() = 'hod'
      AND institution_id = my_institution()
      AND department_id = (SELECT p.department_id FROM public.profiles p WHERE p.id = auth.uid())
    )
  );
