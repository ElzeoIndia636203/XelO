-- Allow course faculty to delete a batch before any session has been conducted or started.

CREATE OR REPLACE FUNCTION delete_course_batch(p_batch_id uuid)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_batch public.batches%ROWTYPE;
BEGIN
  SELECT * INTO v_batch FROM public.batches WHERE id = p_batch_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'not_found';
  END IF;

  IF NOT is_course_faculty(v_batch.course_id) THEN
    RAISE EXCEPTION 'forbidden';
  END IF;

  IF EXISTS (
    SELECT 1 FROM public.sessions
    WHERE course_id = v_batch.course_id AND status = 'conducted'
  ) THEN
    RAISE EXCEPTION 'sessions_already_conducted';
  END IF;

  IF EXISTS (SELECT 1 FROM public.session_runs WHERE batch_id = p_batch_id) THEN
    RAISE EXCEPTION 'not_editable';
  END IF;

  DELETE FROM public.pending_enrollments WHERE batch_id = p_batch_id;
  DELETE FROM public.enrollments WHERE batch_id = p_batch_id;
  DELETE FROM public.batches WHERE id = p_batch_id;

  PERFORM public.audit(
    'delete_batch',
    'batch',
    p_batch_id::text,
    jsonb_build_object('course_id', v_batch.course_id, 'name', v_batch.name),
    v_batch.institution_id
  );
END;
$$;

GRANT EXECUTE ON FUNCTION delete_course_batch(uuid) TO authenticated;
