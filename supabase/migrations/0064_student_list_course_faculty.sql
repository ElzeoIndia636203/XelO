-- Dedicated SECURITY DEFINER lookup for a student's enrolled course faculty
-- (profiles_read RLS blocks students from querying public.profiles directly).
CREATE OR REPLACE FUNCTION student_list_course_faculty()
RETURNS TABLE (
  id uuid,
  full_name text,
  email text,
  role text,
  relation text
)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT DISTINCT
    p.id,
    coalesce(NULLIF(trim(p.full_name), ''), p.email) AS full_name,
    p.email,
    p.role::text AS role,
    'superior'::text AS relation
  FROM public.enrollments e
  JOIN public.courses c ON c.id = e.course_id
  JOIN public.profiles p ON p.id = c.faculty_id
  WHERE e.student_id = auth.uid();
$$;

GRANT EXECUTE ON FUNCTION student_list_course_faculty() TO authenticated;
