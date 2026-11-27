-- Allow course faculty to bulk-move or remove enrolled / pending students in a course
-- before any session has been conducted.

CREATE OR REPLACE FUNCTION move_students_bulk(
  p_course_id uuid,
  p_enrollment_ids uuid[] DEFAULT '{}',
  p_pending_ids uuid[] DEFAULT '{}',
  p_to_batch_id uuid DEFAULT NULL
)
RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_inst uuid;
  v_enr_count integer := 0;
  v_pend_count integer := 0;
BEGIN
  IF NOT is_course_faculty(p_course_id) THEN
    RAISE EXCEPTION 'forbidden';
  END IF;

  IF EXISTS (SELECT 1 FROM public.sessions WHERE course_id = p_course_id AND status = 'conducted') THEN
    RAISE EXCEPTION 'sessions_already_conducted';
  END IF;

  SELECT institution_id INTO v_inst
  FROM public.batches
  WHERE id = p_to_batch_id AND course_id = p_course_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'invalid_scope';
  END IF;

  IF cardinality(COALESCE(p_enrollment_ids, '{}')) > 0 THEN
    UPDATE public.enrollments
    SET batch_id = p_to_batch_id
    WHERE course_id = p_course_id AND id = ANY(p_enrollment_ids);
    GET DIAGNOSTICS v_enr_count = ROW_COUNT;
  END IF;

  IF cardinality(COALESCE(p_pending_ids, '{}')) > 0 THEN
    UPDATE public.pending_enrollments
    SET batch_id = p_to_batch_id
    WHERE course_id = p_course_id AND id = ANY(p_pending_ids);
    GET DIAGNOSTICS v_pend_count = ROW_COUNT;
  END IF;

  PERFORM public.audit(
    'move_students_bulk',
    'batch',
    p_to_batch_id::text,
    jsonb_build_object(
      'course_id', p_course_id,
      'moved_enrollments', v_enr_count,
      'moved_pending', v_pend_count
    ),
    v_inst
  );

  RETURN v_enr_count + v_pend_count;
END;
$$;

CREATE OR REPLACE FUNCTION remove_course_students(
  p_course_id uuid,
  p_enrollment_ids uuid[] DEFAULT '{}',
  p_pending_ids uuid[] DEFAULT '{}'
)
RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_inst uuid;
  v_enr_count integer := 0;
  v_pend_count integer := 0;
BEGIN
  IF NOT is_course_faculty(p_course_id) THEN
    RAISE EXCEPTION 'forbidden';
  END IF;

  IF EXISTS (SELECT 1 FROM public.sessions WHERE course_id = p_course_id AND status = 'conducted') THEN
    RAISE EXCEPTION 'sessions_already_conducted';
  END IF;

  SELECT institution_id INTO v_inst FROM public.courses WHERE id = p_course_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'not_found';
  END IF;

  IF cardinality(COALESCE(p_enrollment_ids, '{}')) > 0 THEN
    DELETE FROM public.enrollments
    WHERE course_id = p_course_id AND id = ANY(p_enrollment_ids);
    GET DIAGNOSTICS v_enr_count = ROW_COUNT;
  END IF;

  IF cardinality(COALESCE(p_pending_ids, '{}')) > 0 THEN
    DELETE FROM public.pending_enrollments
    WHERE course_id = p_course_id AND id = ANY(p_pending_ids);
    GET DIAGNOSTICS v_pend_count = ROW_COUNT;
  END IF;

  PERFORM public.audit(
    'remove_course_students',
    'course',
    p_course_id::text,
    jsonb_build_object(
      'removed_enrollments', v_enr_count,
      'removed_pending', v_pend_count
    ),
    v_inst
  );

  RETURN v_enr_count + v_pend_count;
END;
$$;

GRANT EXECUTE ON FUNCTION move_students_bulk(uuid, uuid[], uuid[], uuid) TO authenticated;
GRANT EXECUTE ON FUNCTION remove_course_students(uuid, uuid[], uuid[]) TO authenticated;
