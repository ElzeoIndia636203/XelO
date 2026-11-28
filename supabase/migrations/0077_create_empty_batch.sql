-- Allow course faculty to create an empty batch (with a generated class code)
-- so students can be moved into it from existing batches or invited directly.

CREATE OR REPLACE FUNCTION create_course_batch(
  p_course_id uuid,
  p_name text,
  p_slot text DEFAULT '',
  p_room text DEFAULT '',
  p_staff text DEFAULT ''
)
RETURNS public.batches
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_inst uuid;
  v_name text := trim(coalesce(p_name, ''));
  v_batch public.batches%ROWTYPE;
BEGIN
  IF NOT is_course_faculty(p_course_id) THEN
    RAISE EXCEPTION 'forbidden';
  END IF;

  SELECT institution_id INTO v_inst FROM public.courses WHERE id = p_course_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'not_found';
  END IF;

  IF v_name = '' THEN
    RAISE EXCEPTION 'invalid_input';
  END IF;

  IF EXISTS (
    SELECT 1
    FROM public.batches
    WHERE course_id = p_course_id
      AND lower(name) = lower(v_name)
  ) THEN
    RAISE EXCEPTION 'batch_name_exists';
  END IF;

  INSERT INTO public.batches (course_id, institution_id, name, class_code, slot, room, staff)
  VALUES (
    p_course_id,
    v_inst,
    v_name,
    public.generate_class_code(),
    trim(coalesce(p_slot, '')),
    trim(coalesce(p_room, '')),
    trim(coalesce(p_staff, ''))
  )
  RETURNING * INTO v_batch;

  PERFORM public.audit(
    'create_batch',
    'batch',
    v_batch.id::text,
    jsonb_build_object('course_id', p_course_id, 'name', v_batch.name),
    v_inst
  );

  RETURN v_batch;
END;
$$;

GRANT EXECUTE ON FUNCTION create_course_batch(uuid, text, text, text, text) TO authenticated;
