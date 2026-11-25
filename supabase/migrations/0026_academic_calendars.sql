-- Department academic calendar managed by HOD and used by faculty in session planning.

CREATE TABLE academic_calendars (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  institution_id uuid NOT NULL REFERENCES institutions(id) ON DELETE CASCADE,
  department_id uuid NOT NULL REFERENCES departments(id) ON DELETE CASCADE,
  first_working_day date NOT NULL,
  last_working_day date NOT NULL,
  expected_endsem_date date,
  saturday_rule text NOT NULL DEFAULT 'all' CHECK (saturday_rule IN ('all', 'odd', 'even', 'none')),
  approved boolean NOT NULL DEFAULT false,
  approved_by uuid REFERENCES profiles(id) ON DELETE SET NULL,
  approved_at timestamptz,
  created_by uuid REFERENCES profiles(id) ON DELETE SET NULL,
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (department_id)
);

CREATE TABLE academic_calendar_events (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  calendar_id uuid NOT NULL REFERENCES academic_calendars(id) ON DELETE CASCADE,
  institution_id uuid NOT NULL REFERENCES institutions(id) ON DELETE CASCADE,
  department_id uuid NOT NULL REFERENCES departments(id) ON DELETE CASCADE,
  day date NOT NULL,
  kind text NOT NULL CHECK (kind IN ('internal_exam', 'regional_holiday', 'other_holiday', 'leave')),
  label text NOT NULL,
  UNIQUE (calendar_id, day)
);

CREATE INDEX idx_acad_cal_dept ON academic_calendars(department_id);
CREATE INDEX idx_acad_cal_events_cal ON academic_calendar_events(calendar_id, day);

ALTER TABLE academic_calendars ENABLE ROW LEVEL SECURITY;
ALTER TABLE academic_calendar_events ENABLE ROW LEVEL SECURITY;

GRANT SELECT, INSERT, UPDATE, DELETE ON academic_calendars, academic_calendar_events TO authenticated;
GRANT ALL ON academic_calendars, academic_calendar_events TO service_role;

CREATE POLICY acad_cal_read ON academic_calendars
  FOR SELECT TO authenticated
  USING (has_role('super_admin') OR institution_id = my_institution());

CREATE POLICY acad_cal_insert ON academic_calendars
  FOR INSERT TO authenticated
  WITH CHECK (
    has_role('super_admin')
    OR (
      has_role('hod')
      AND institution_id = my_institution()
      AND department_id = (SELECT p.department_id FROM public.profiles p WHERE p.id = auth.uid())
    )
  );

CREATE POLICY acad_cal_update ON academic_calendars
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

CREATE POLICY acad_cal_delete ON academic_calendars
  FOR DELETE TO authenticated
  USING (
    has_role('super_admin')
    OR (
      has_role('hod')
      AND institution_id = my_institution()
      AND department_id = (SELECT p.department_id FROM public.profiles p WHERE p.id = auth.uid())
    )
  );

CREATE POLICY acad_cal_events_read ON academic_calendar_events
  FOR SELECT TO authenticated
  USING (has_role('super_admin') OR institution_id = my_institution());

CREATE POLICY acad_cal_events_insert ON academic_calendar_events
  FOR INSERT TO authenticated
  WITH CHECK (
    has_role('super_admin')
    OR (
      has_role('hod')
      AND institution_id = my_institution()
      AND department_id = (SELECT p.department_id FROM public.profiles p WHERE p.id = auth.uid())
    )
  );

CREATE POLICY acad_cal_events_update ON academic_calendar_events
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

CREATE POLICY acad_cal_events_delete ON academic_calendar_events
  FOR DELETE TO authenticated
  USING (
    has_role('super_admin')
    OR (
      has_role('hod')
      AND institution_id = my_institution()
      AND department_id = (SELECT p.department_id FROM public.profiles p WHERE p.id = auth.uid())
    )
  );
