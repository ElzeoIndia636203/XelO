-- Allow faculty to reject (remove) an unpicked lab question candidate.

CREATE OR REPLACE FUNCTION faculty_reject_question(p_question_id uuid)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_q public.questions%ROWTYPE;
BEGIN
  SELECT * INTO v_q FROM public.questions WHERE id = p_question_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'not_found';
  END IF;

  IF NOT is_course_faculty(v_q.course_id) AND NOT has_role('super_admin') THEN
    RAISE EXCEPTION 'forbidden';
  END IF;

  DELETE FROM public.session_questions WHERE question_id = p_question_id;
  DELETE FROM public.questions WHERE id = p_question_id;

  IF v_q.session_id IS NOT NULL THEN
    PERFORM public.refresh_session_status(v_q.session_id);
  END IF;
END;
$$;

GRANT EXECUTE ON FUNCTION faculty_reject_question(uuid) TO authenticated;
