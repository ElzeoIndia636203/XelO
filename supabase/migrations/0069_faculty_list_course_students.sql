-- SECURITY DEFINER lookup for enrolled student profiles in a course
-- so Roll No, Full Name, and Email always appear in Batches, Sessions, Instant Tests, and Reports
-- even if institution_id differs or profiles_read RLS omits a row.
CREATE OR REPLACE FUNCTION faculty_list_course_students(p_course_id uuid)
RETURNS SETOF public.profiles
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  IF NOT (is_course_faculty(p_course_id) OR can_oversee_course(p_course_id) OR is_super_admin()) THEN
    RAISE EXCEPTION 'forbidden';
  END IF;

  RETURN QUERY
  SELECT p.*
  FROM public.enrollments e
  JOIN public.profiles p ON p.id = e.student_id
  WHERE e.course_id = p_course_id
  ORDER BY coalesce(p.roll_no, ''), coalesce(p.full_name, '');
END;
$$;

GRANT EXECUTE ON FUNCTION faculty_list_course_students(uuid) TO authenticated;
