-- Phase 3: Lab prep RLS policies and column/state guards (no FORCE ROW LEVEL SECURITY)

CREATE OR REPLACE FUNCTION student_can_see_question(q uuid)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT EXISTS (
    SELECT 1
    FROM public.session_questions sq
    JOIN public.sessions s ON s.id = sq.session_id
    WHERE sq.question_id = q
      AND s.status IN ('active', 'conducted')
      AND is_course_student(s.course_id)
  );
$$;

ALTER TABLE questions ENABLE ROW LEVEL SECURITY;
ALTER TABLE test_cases ENABLE ROW LEVEL SECURITY;
ALTER TABLE reference_solutions ENABLE ROW LEVEL SECURITY;
ALTER TABLE session_questions ENABLE ROW LEVEL SECURITY;
ALTER TABLE bank_items ENABLE ROW LEVEL SECURITY;
ALTER TABLE submissions ENABLE ROW LEVEL SECURITY;

REVOKE ALL ON TABLE
  questions,
  test_cases,
  reference_solutions,
  session_questions,
  bank_items,
  submissions
FROM anon, authenticated;

GRANT SELECT ON TABLE
  questions,
  test_cases,
  reference_solutions,
  session_questions,
  bank_items,
  submissions
TO authenticated;

GRANT INSERT, UPDATE, DELETE ON TABLE
  questions,
  test_cases,
  reference_solutions,
  bank_items
TO authenticated;

GRANT ALL ON TABLE
  questions,
  test_cases,
  reference_solutions,
  session_questions,
  bank_items,
  submissions
TO service_role;

-- Read policies
CREATE POLICY questions_read ON questions
  FOR SELECT TO authenticated
  USING (
    is_course_faculty(course_id)
    OR can_oversee_course(course_id)
    OR student_can_see_question(id)
  );

CREATE POLICY questions_insert ON questions
  FOR INSERT TO authenticated
  WITH CHECK (
    is_course_faculty(course_id)
    AND institution_id = my_institution()
  );

CREATE POLICY questions_update ON questions
  FOR UPDATE TO authenticated
  USING (is_course_faculty(course_id))
  WITH CHECK (is_course_faculty(course_id));

CREATE POLICY questions_delete ON questions
  FOR DELETE TO authenticated
  USING (is_course_faculty(course_id));

CREATE POLICY test_cases_read ON test_cases
  FOR SELECT TO authenticated
  USING (
    EXISTS (
      SELECT 1
      FROM public.questions q
      WHERE q.id = question_id
        AND (is_course_faculty(q.course_id) OR can_oversee_course(q.course_id))
    )
    OR (NOT hidden AND student_can_see_question(question_id))
  );

CREATE POLICY test_cases_write ON test_cases
  FOR ALL TO authenticated
  USING (
    EXISTS (
      SELECT 1 FROM public.questions q
      WHERE q.id = question_id AND is_course_faculty(q.course_id)
    )
  )
  WITH CHECK (
    EXISTS (
      SELECT 1 FROM public.questions q
      WHERE q.id = question_id AND is_course_faculty(q.course_id)
    )
  );

-- Students never read reference solutions
CREATE POLICY reference_solutions_read ON reference_solutions
  FOR SELECT TO authenticated
  USING (
    EXISTS (
      SELECT 1 FROM public.questions q
      WHERE q.id = question_id
        AND (is_course_faculty(q.course_id) OR can_oversee_course(q.course_id))
    )
  );

CREATE POLICY reference_solutions_write ON reference_solutions
  FOR ALL TO authenticated
  USING (
    EXISTS (
      SELECT 1 FROM public.questions q
      WHERE q.id = question_id AND is_course_faculty(q.course_id)
    )
  )
  WITH CHECK (
    EXISTS (
      SELECT 1 FROM public.questions q
      WHERE q.id = question_id AND is_course_faculty(q.course_id)
    )
  );

CREATE POLICY session_questions_read ON session_questions
  FOR SELECT TO authenticated
  USING (
    EXISTS (
      SELECT 1 FROM public.sessions s
      WHERE s.id = session_id
        AND (
          is_course_faculty(s.course_id)
          OR can_oversee_course(s.course_id)
          OR (s.status IN ('active', 'conducted') AND is_course_student(s.course_id))
        )
    )
  );

-- Students never read bank_items (contains MCQ answers)
CREATE POLICY bank_items_read ON bank_items
  FOR SELECT TO authenticated
  USING (
    EXISTS (
      SELECT 1 FROM public.sessions s
      WHERE s.id = session_id
        AND (is_course_faculty(s.course_id) OR can_oversee_course(s.course_id))
    )
  );

CREATE POLICY bank_items_write ON bank_items
  FOR ALL TO authenticated
  USING (
    EXISTS (
      SELECT 1 FROM public.sessions s
      WHERE s.id = session_id AND is_course_faculty(s.course_id)
    )
  )
  WITH CHECK (
    EXISTS (
      SELECT 1 FROM public.sessions s
      WHERE s.id = session_id AND is_course_faculty(s.course_id)
    )
  );

CREATE POLICY submissions_read ON submissions
  FOR SELECT TO authenticated
  USING (
    student_id = auth.uid()
    OR is_course_faculty(course_id)
    OR can_oversee_course(course_id)
  );

-- Guard helpers (definer so child table edits can reset parent question valid flag cleanly)
CREATE OR REPLACE FUNCTION invalidate_question_for_faculty(p_question_id uuid)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_cid uuid;
BEGIN
  SELECT course_id INTO v_cid FROM public.questions WHERE id = p_question_id;
  IF v_cid IS NOT NULL AND is_course_faculty(v_cid) THEN
    UPDATE public.questions
    SET valid = NULL, status = 'candidate', validation_note = 'Re-validation required'
    WHERE id = p_question_id;
  END IF;
END;
$$;

REVOKE ALL ON FUNCTION public.invalidate_question_for_faculty(uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.invalidate_question_for_faculty(uuid) TO authenticated;

CREATE OR REPLACE FUNCTION guard_question()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF NOT is_api_user() THEN
    RETURN COALESCE(NEW, OLD);
  END IF;

  IF TG_OP = 'INSERT' THEN
    IF NEW.status <> 'candidate' OR NEW.valid IS NOT NULL OR NEW.source <> 'faculty' THEN
      RAISE EXCEPTION 'forbidden';
    END IF;
    NEW.created_by := auth.uid();
    RETURN NEW;
  END IF;

  IF TG_OP = 'UPDATE' THEN
    IF NEW.status IS DISTINCT FROM OLD.status
       OR NEW.valid IS DISTINCT FROM OLD.valid
       OR NEW.validation_note IS DISTINCT FROM OLD.validation_note
       OR NEW.source IS DISTINCT FROM OLD.source
       OR NEW.course_id IS DISTINCT FROM OLD.course_id
       OR NEW.institution_id IS DISTINCT FROM OLD.institution_id
       OR NEW.kind IS DISTINCT FROM OLD.kind THEN
      RAISE EXCEPTION 'forbidden';
    END IF;

    IF EXISTS (SELECT 1 FROM public.session_questions WHERE question_id = OLD.id) THEN
      RAISE EXCEPTION 'not_editable';
    END IF;

    NEW.valid := NULL;
    NEW.status := 'candidate';
    NEW.validation_note := 'Re-validation required';
    RETURN NEW;
  END IF;

  IF TG_OP = 'DELETE' THEN
    IF EXISTS (SELECT 1 FROM public.session_questions WHERE question_id = OLD.id) THEN
      RAISE EXCEPTION 'not_editable';
    END IF;
    RETURN OLD;
  END IF;

  RETURN COALESCE(NEW, OLD);
END;
$$;

CREATE TRIGGER trg_guard_question
  BEFORE INSERT OR UPDATE OR DELETE ON questions
  FOR EACH ROW
  EXECUTE FUNCTION guard_question();

CREATE OR REPLACE FUNCTION guard_test_cases()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  v_qid uuid := COALESCE(NEW.question_id, OLD.question_id);
BEGIN
  IF NOT is_api_user() THEN
    RETURN COALESCE(NEW, OLD);
  END IF;

  IF EXISTS (SELECT 1 FROM public.session_questions WHERE question_id = v_qid) THEN
    RAISE EXCEPTION 'not_editable';
  END IF;

  PERFORM public.invalidate_question_for_faculty(v_qid);
  RETURN COALESCE(NEW, OLD);
END;
$$;

CREATE TRIGGER trg_guard_test_cases
  BEFORE INSERT OR UPDATE OR DELETE ON test_cases
  FOR EACH ROW
  EXECUTE FUNCTION guard_test_cases();

CREATE OR REPLACE FUNCTION guard_reference_solutions()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  v_qid uuid := COALESCE(NEW.question_id, OLD.question_id);
BEGIN
  IF NOT is_api_user() THEN
    RETURN COALESCE(NEW, OLD);
  END IF;

  IF EXISTS (SELECT 1 FROM public.session_questions WHERE question_id = v_qid) THEN
    RAISE EXCEPTION 'not_editable';
  END IF;

  PERFORM public.invalidate_question_for_faculty(v_qid);
  RETURN COALESCE(NEW, OLD);
END;
$$;

CREATE TRIGGER trg_guard_reference_solutions
  BEFORE INSERT OR UPDATE OR DELETE ON reference_solutions
  FOR EACH ROW
  EXECUTE FUNCTION guard_reference_solutions();

CREATE OR REPLACE FUNCTION guard_bank_items()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF NOT is_api_user() THEN
    RETURN COALESCE(NEW, OLD);
  END IF;

  IF TG_OP = 'INSERT' THEN
    IF NEW.approved IS TRUE THEN
      RAISE EXCEPTION 'forbidden';
    END IF;
    RETURN NEW;
  END IF;

  IF TG_OP = 'UPDATE' THEN
    IF NEW.approved IS DISTINCT FROM OLD.approved
       OR NEW.session_id IS DISTINCT FROM OLD.session_id
       OR NEW.institution_id IS DISTINCT FROM OLD.institution_id THEN
      RAISE EXCEPTION 'forbidden';
    END IF;
    NEW.approved := false;
    RETURN NEW;
  END IF;

  RETURN OLD;
END;
$$;

CREATE TRIGGER trg_guard_bank_items
  BEFORE INSERT OR UPDATE OR DELETE ON bank_items
  FOR EACH ROW
  EXECUTE FUNCTION guard_bank_items();
