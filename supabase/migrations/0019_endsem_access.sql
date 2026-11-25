-- =============================================================
-- 0019 End-sem practical access & column guards
-- =============================================================

ALTER TABLE assessments ENABLE ROW LEVEL SECURITY;
ALTER TABLE assessment_questions ENABLE ROW LEVEL SECURITY;
ALTER TABLE exam_papers ENABLE ROW LEVEL SECURITY;
ALTER TABLE proctor_events ENABLE ROW LEVEL SECURITY;

-- ── assessments ──────────────────────────────────────────────────────────

CREATE POLICY assessments_staff_select ON assessments
  FOR SELECT TO authenticated
  USING (can_read_course(course_id));

CREATE POLICY assessments_student_select ON assessments
  FOR SELECT TO authenticated
  USING (
    EXISTS (
      SELECT 1 FROM enrollments e
      WHERE e.course_id = assessments.course_id
        AND e.batch_id = assessments.batch_id
        AND e.student_id = auth.uid()
    )
    AND stage IN ('scheduled', 'live', 'marks')
  );

-- ── assessment_questions ─────────────────────────────────────────────────
-- Students can never read unpicked or full 40/30 bank; they only read
-- questions assigned to their own exam_paper via questions RLS.

CREATE POLICY assessment_questions_staff_select ON assessment_questions
  FOR SELECT TO authenticated
  USING (
    EXISTS (
      SELECT 1 FROM assessments a
      WHERE a.id = assessment_questions.assessment_id
        AND can_read_course(a.course_id)
    )
  );

-- ── exam_papers ──────────────────────────────────────────────────────────

CREATE POLICY exam_papers_student_select ON exam_papers
  FOR SELECT TO authenticated
  USING (student_id = auth.uid());

CREATE POLICY exam_papers_staff_select ON exam_papers
  FOR SELECT TO authenticated
  USING (
    EXISTS (
      SELECT 1 FROM assessments a
      WHERE a.id = exam_papers.assessment_id
        AND can_read_course(a.course_id)
    )
  );

-- ── proctor_events ───────────────────────────────────────────────────────

CREATE POLICY proctor_events_staff_select ON proctor_events
  FOR SELECT TO authenticated
  USING (
    EXISTS (
      SELECT 1 FROM exam_papers ep
      JOIN assessments a ON a.id = ep.assessment_id
      WHERE ep.id = proctor_events.paper_id
        AND can_read_course(a.course_id)
    )
  );

CREATE POLICY proctor_events_student_select ON proctor_events
  FOR SELECT TO authenticated
  USING (
    EXISTS (
      SELECT 1 FROM exam_papers ep
      WHERE ep.id = proctor_events.paper_id
        AND ep.student_id = auth.uid()
    )
  );

-- ── column guards ────────────────────────────────────────────────────────

CREATE OR REPLACE FUNCTION guard_assessments_update()
RETURNS trigger LANGUAGE plpgsql SET search_path = public
AS $$
BEGIN
  IF is_api_user() THEN
    IF new.stage IS DISTINCT FROM old.stage
       OR new.hod_status IS DISTINCT FROM old.hod_status
       OR new.hod_remark IS DISTINCT FROM old.hod_remark
       OR new.rules_locked IS DISTINCT FROM old.rules_locked
       OR new.attendance_done IS DISTINCT FROM old.attendance_done
       OR new.activated_at IS DISTINCT FROM old.activated_at
       OR new.ended_at IS DISTINCT FROM old.ended_at
       OR new.added_to_file IS DISTINCT FROM old.added_to_file THEN
      RAISE EXCEPTION 'protected_columns';
    END IF;
  END IF;
  RETURN new;
END;
$$;

DROP TRIGGER IF EXISTS trg_guard_assessments ON assessments;
CREATE TRIGGER trg_guard_assessments
  BEFORE UPDATE ON assessments
  FOR EACH ROW EXECUTE FUNCTION guard_assessments_update();

CREATE OR REPLACE FUNCTION guard_exam_papers_update()
RETURNS trigger LANGUAGE plpgsql SET search_path = public
AS $$
BEGIN
  IF is_api_user() THEN
    IF new.q_ids IS DISTINCT FROM old.q_ids
       OR new.deadline IS DISTINCT FROM old.deadline
       OR new.extra_minutes IS DISTINCT FROM old.extra_minutes
       OR new.submitted_at IS DISTINCT FROM old.submitted_at
       OR new.flagged IS DISTINCT FROM old.flagged THEN
      RAISE EXCEPTION 'protected_columns';
    END IF;
  END IF;
  RETURN new;
END;
$$;

DROP TRIGGER IF EXISTS trg_guard_exam_papers ON exam_papers;
CREATE TRIGGER trg_guard_exam_papers
  BEFORE UPDATE ON exam_papers
  FOR EACH ROW EXECUTE FUNCTION guard_exam_papers_update();

-- ── storage policies for proctor bucket ──────────────────────────────────

DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.tables
    WHERE table_schema = 'storage' AND table_name = 'objects'
  ) THEN
    IF NOT EXISTS (
      SELECT 1 FROM pg_policies
      WHERE schemaname = 'storage' AND tablename = 'objects' AND policyname = 'proctor_student_insert'
    ) THEN
      EXECUTE $p$
        CREATE POLICY proctor_student_insert ON storage.objects
          FOR INSERT TO authenticated
          WITH CHECK (
            bucket_id = 'proctor'
            AND (storage.foldername(name))[1] = auth.uid()::text
          )
      $p$;
    END IF;

    IF NOT EXISTS (
      SELECT 1 FROM pg_policies
      WHERE schemaname = 'storage' AND tablename = 'objects' AND policyname = 'proctor_staff_select'
    ) THEN
      EXECUTE $p$
        CREATE POLICY proctor_staff_select ON storage.objects
          FOR SELECT TO authenticated
          USING (
            bucket_id = 'proctor'
            AND my_role() IN ('faculty', 'hod', 'dean', 'coe', 'vc', 'super_admin')
          )
      $p$;
    END IF;
  END IF;
END $$;
