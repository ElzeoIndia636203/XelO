-- Phase 4: Lab run RLS policies and column/table guards (no FORCE ROW LEVEL SECURITY)

ALTER TABLE session_runs ENABLE ROW LEVEL SECURITY;
ALTER TABLE attendance ENABLE ROW LEVEL SECURITY;
ALTER TABLE test_attempts ENABLE ROW LEVEL SECURITY;
ALTER TABLE drafts ENABLE ROW LEVEL SECURITY;
ALTER TABLE viva ENABLE ROW LEVEL SECURITY;
ALTER TABLE lab_checkins ENABLE ROW LEVEL SECURITY;
ALTER TABLE course_flags ENABLE ROW LEVEL SECURITY;
ALTER TABLE notifications ENABLE ROW LEVEL SECURITY;

REVOKE ALL ON TABLE
  session_runs,
  attendance,
  test_attempts,
  drafts,
  viva,
  lab_checkins,
  course_flags,
  notifications
FROM anon, authenticated;

GRANT SELECT ON TABLE
  session_runs,
  attendance,
  test_attempts,
  drafts,
  viva,
  lab_checkins,
  course_flags,
  notifications
TO authenticated;

GRANT INSERT, UPDATE ON TABLE drafts TO authenticated;
GRANT UPDATE (read_at) ON TABLE notifications TO authenticated;
GRANT DELETE ON TABLE course_flags TO authenticated;

GRANT ALL ON TABLE
  session_runs,
  attendance,
  test_attempts,
  drafts,
  viva,
  lab_checkins,
  course_flags,
  notifications
TO service_role;

CREATE POLICY session_runs_read ON session_runs
  FOR SELECT TO authenticated
  USING (
    EXISTS (
      SELECT 1
      FROM public.sessions s
      WHERE s.id = session_id
        AND (
          is_course_faculty(s.course_id)
          OR can_oversee_course(s.course_id)
          OR EXISTS (
            SELECT 1
            FROM public.enrollments e
            JOIN public.profiles p ON p.id = e.student_id
            WHERE e.batch_id = batch_id
              AND e.student_id = auth.uid()
              AND p.active = true
          )
        )
    )
  );

CREATE POLICY attendance_read ON attendance
  FOR SELECT TO authenticated
  USING (
    student_id = auth.uid()
    OR (
      session_run_id IS NOT NULL
      AND EXISTS (
        SELECT 1
        FROM public.session_runs sr
        JOIN public.sessions s ON s.id = sr.session_id
        WHERE sr.id = session_run_id
          AND (is_course_faculty(s.course_id) OR can_oversee_course(s.course_id))
      )
    )
  );

CREATE POLICY test_attempts_read ON test_attempts
  FOR SELECT TO authenticated
  USING (
    student_id = auth.uid()
    OR EXISTS (
      SELECT 1
      FROM public.sessions s
      WHERE s.id = session_id
        AND (is_course_faculty(s.course_id) OR can_oversee_course(s.course_id))
    )
  );

CREATE POLICY drafts_read ON drafts
  FOR SELECT TO authenticated
  USING (
    student_id = auth.uid()
    OR EXISTS (
      SELECT 1
      FROM public.questions q
      WHERE q.id = question_id
        AND (is_course_faculty(q.course_id) OR can_oversee_course(q.course_id))
    )
  );

CREATE POLICY drafts_insert ON drafts
  FOR INSERT TO authenticated
  WITH CHECK (
    student_id = auth.uid()
    AND institution_id = my_institution()
    AND EXISTS (
      SELECT 1
      FROM public.questions q
      WHERE q.id = question_id
        AND (is_course_faculty(q.course_id) OR is_course_student(q.course_id))
    )
  );

CREATE POLICY drafts_update ON drafts
  FOR UPDATE TO authenticated
  USING (student_id = auth.uid())
  WITH CHECK (student_id = auth.uid());

CREATE POLICY viva_read ON viva
  FOR SELECT TO authenticated
  USING (
    student_id = auth.uid()
    OR (
      session_id IS NOT NULL
      AND EXISTS (
        SELECT 1
        FROM public.sessions s
        WHERE s.id = session_id
          AND (is_course_faculty(s.course_id) OR can_oversee_course(s.course_id))
      )
    )
  );

CREATE POLICY lab_checkins_read ON lab_checkins
  FOR SELECT TO authenticated
  USING (
    student_id = auth.uid()
    OR EXISTS (
      SELECT 1
      FROM public.sessions s
      WHERE s.id = session_id
        AND (is_course_faculty(s.course_id) OR can_oversee_course(s.course_id))
    )
  );

CREATE POLICY course_flags_read ON course_flags
  FOR SELECT TO authenticated
  USING (is_course_faculty(course_id) OR can_oversee_course(course_id));

CREATE POLICY course_flags_delete ON course_flags
  FOR DELETE TO authenticated
  USING (is_course_faculty(course_id));

CREATE POLICY notifications_read ON notifications
  FOR SELECT TO authenticated
  USING (user_id = auth.uid());

CREATE POLICY notifications_update ON notifications
  FOR UPDATE TO authenticated
  USING (user_id = auth.uid())
  WITH CHECK (user_id = auth.uid());

-- Per-table guard triggers (SECURITY INVOKER so is_api_user() detects direct client calls)
CREATE OR REPLACE FUNCTION guard_notifications()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF NOT is_api_user() THEN
    RETURN COALESCE(NEW, OLD);
  END IF;

  IF TG_OP = 'INSERT' THEN
    RAISE EXCEPTION 'forbidden';
  END IF;

  IF TG_OP = 'UPDATE' THEN
    IF NEW.user_id IS DISTINCT FROM OLD.user_id
       OR NEW.institution_id IS DISTINCT FROM OLD.institution_id
       OR NEW.kind IS DISTINCT FROM OLD.kind
       OR NEW.title IS DISTINCT FROM OLD.title
       OR NEW.body IS DISTINCT FROM OLD.body
       OR NEW.link IS DISTINCT FROM OLD.link
       OR NEW.created_at IS DISTINCT FROM OLD.created_at THEN
      RAISE EXCEPTION 'forbidden';
    END IF;
    RETURN NEW;
  END IF;

  RETURN OLD;
END;
$$;

CREATE TRIGGER trg_guard_notifications
  BEFORE INSERT OR UPDATE ON notifications
  FOR EACH ROW
  EXECUTE FUNCTION guard_notifications();

CREATE OR REPLACE FUNCTION guard_drafts()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF NOT is_api_user() THEN
    RETURN NEW;
  END IF;

  IF TG_OP = 'UPDATE' THEN
    IF NEW.student_id IS DISTINCT FROM OLD.student_id
       OR NEW.question_id IS DISTINCT FROM OLD.question_id
       OR NEW.institution_id IS DISTINCT FROM OLD.institution_id
       OR NEW.context IS DISTINCT FROM OLD.context
       OR NEW.lang IS DISTINCT FROM OLD.lang THEN
      RAISE EXCEPTION 'forbidden';
    END IF;
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER trg_guard_drafts
  BEFORE INSERT OR UPDATE ON drafts
  FOR EACH ROW
  EXECUTE FUNCTION guard_drafts();
