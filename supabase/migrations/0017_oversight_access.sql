-- =============================================================
-- 0017 Oversight access
-- RLS policies for holidays (insert/delete for CoE/VC)
-- Column guard for institutions.min_attendance_pct
-- =============================================================

CREATE OR REPLACE FUNCTION guard_institutions_update()
RETURNS trigger LANGUAGE plpgsql SET search_path = public
AS $$
BEGIN
  IF is_api_user() THEN
    IF new.min_attendance_pct IS DISTINCT FROM old.min_attendance_pct THEN
      RAISE EXCEPTION 'use_set_min_attendance';
    END IF;
  END IF;
  RETURN new;
END;
$$;

DROP TRIGGER IF EXISTS trg_guard_institutions ON institutions;
CREATE TRIGGER trg_guard_institutions
  BEFORE UPDATE ON institutions
  FOR EACH ROW EXECUTE FUNCTION guard_institutions_update();

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies
    WHERE tablename = 'holidays' AND policyname = 'holidays_insert'
  ) THEN
    EXECUTE $p$
      CREATE POLICY holidays_insert ON holidays
        FOR INSERT TO authenticated
        WITH CHECK (institution_id = my_institution() AND my_role() IN ('coe','vc'))
    $p$;
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_policies
    WHERE tablename = 'holidays' AND policyname = 'holidays_delete'
  ) THEN
    EXECUTE $p$
      CREATE POLICY holidays_delete ON holidays
        FOR DELETE TO authenticated
        USING (institution_id = my_institution() AND my_role() IN ('coe','vc'))
    $p$;
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_policies
    WHERE tablename = 'holidays' AND policyname = 'holidays_select'
  ) THEN
    EXECUTE $p$
      CREATE POLICY holidays_select ON holidays
        FOR SELECT TO authenticated
        USING (institution_id = my_institution())
    $p$;
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_policies
    WHERE tablename = 'course_snapshots' AND policyname = 'course_snapshots_oversight_select'
  ) THEN
    EXECUTE $p$
      CREATE POLICY course_snapshots_oversight_select ON course_snapshots
        FOR SELECT TO authenticated
        USING (can_read_course(course_id))
    $p$;
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_policies
    WHERE tablename = 'departments' AND policyname = 'departments_institution_select'
  ) THEN
    EXECUTE $p$
      CREATE POLICY departments_institution_select ON departments
        FOR SELECT TO authenticated
        USING (institution_id = my_institution())
    $p$;
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_policies
    WHERE tablename = 'schools' AND policyname = 'schools_institution_select'
  ) THEN
    EXECUTE $p$
      CREATE POLICY schools_institution_select ON schools
        FOR SELECT TO authenticated
        USING (institution_id = my_institution())
    $p$;
  END IF;
END;
$$;
