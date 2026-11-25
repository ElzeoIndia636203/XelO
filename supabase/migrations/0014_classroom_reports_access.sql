-- Phase 5: RLS policies, storage object policies, and column guards (no FORCE ROW LEVEL SECURITY)

ALTER TABLE class_items ENABLE ROW LEVEL SECURITY;
ALTER TABLE class_answer_keys ENABLE ROW LEVEL SECURITY;
ALTER TABLE class_responses ENABLE ROW LEVEL SECURITY;
ALTER TABLE course_notes ENABLE ROW LEVEL SECURITY;
ALTER TABLE course_snapshots ENABLE ROW LEVEL SECURITY;

REVOKE ALL ON TABLE
  class_items,
  class_answer_keys,
  class_responses,
  course_notes,
  course_snapshots
FROM anon, authenticated;

GRANT SELECT ON TABLE
  class_items,
  class_answer_keys,
  class_responses,
  course_notes,
  course_snapshots
TO authenticated;

GRANT ALL ON TABLE
  class_items,
  class_answer_keys,
  class_responses,
  course_notes,
  course_snapshots
TO service_role;

CREATE POLICY class_items_read ON class_items
  FOR SELECT TO authenticated
  USING (can_read_course(course_id));

CREATE POLICY class_answer_keys_faculty_only ON class_answer_keys
  FOR SELECT TO authenticated
  USING (
    EXISTS (
      SELECT 1 FROM public.class_items ci
      WHERE ci.id = item_id AND is_course_faculty(ci.course_id)
    )
  );

CREATE POLICY class_responses_read ON class_responses
  FOR SELECT TO authenticated
  USING (
    student_id = auth.uid()
    OR EXISTS (
      SELECT 1 FROM public.class_items ci
      WHERE ci.id = item_id
        AND (is_course_faculty(ci.course_id) OR can_oversee_course(ci.course_id))
    )
  );

CREATE POLICY course_notes_read ON course_notes
  FOR SELECT TO authenticated
  USING (is_course_faculty(course_id) OR can_oversee_course(course_id));

CREATE POLICY course_snapshots_read ON course_snapshots
  FOR SELECT TO authenticated
  USING (is_course_faculty(course_id) OR can_oversee_course(course_id));

-- Extend profile column guard so calendar_token cannot be forged by direct client UPDATE
CREATE OR REPLACE FUNCTION guard_profiles_update()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF is_api_user() THEN
    IF NEW.institution_id IS DISTINCT FROM OLD.institution_id
      OR NEW.email IS DISTINCT FROM OLD.email
      OR NEW.role IS DISTINCT FROM OLD.role
      OR NEW.school_id IS DISTINCT FROM OLD.school_id
      OR NEW.department_id IS DISTINCT FROM OLD.department_id
      OR NEW.roll_no IS DISTINCT FROM OLD.roll_no
      OR NEW.active IS DISTINCT FROM OLD.active
      OR NEW.plan_override IS DISTINCT FROM OLD.plan_override
      OR NEW.calendar_token IS DISTINCT FROM OLD.calendar_token THEN
      RAISE EXCEPTION 'forbidden';
    END IF;
  END IF;
  RETURN NEW;
END;
$$;

-- Storage helper & policies for private class-files bucket (skipped when storage.objects absent in PGlite)
CREATE OR REPLACE FUNCTION storage_course_id_from_path(p_name text)
RETURNS uuid
LANGUAGE plpgsql
IMMUTABLE
AS $$
DECLARE
  v_seg text := split_part(coalesce(p_name, ''), '/', 1);
BEGIN
  RETURN v_seg::uuid;
EXCEPTION WHEN OTHERS THEN
  RETURN NULL;
END;
$$;

DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.tables
    WHERE table_schema = 'storage' AND table_name = 'objects'
  ) THEN
    BEGIN
      EXECUTE 'DROP POLICY IF EXISTS class_files_select ON storage.objects';
      EXECUTE 'DROP POLICY IF EXISTS class_files_insert ON storage.objects';
      EXECUTE 'DROP POLICY IF EXISTS class_files_delete ON storage.objects';

      EXECUTE $p$
        CREATE POLICY class_files_select ON storage.objects
          FOR SELECT TO authenticated
          USING (
            bucket_id = 'class-files'
            AND public.can_read_course(public.storage_course_id_from_path(name))
          )
      $p$;

      EXECUTE $p$
        CREATE POLICY class_files_insert ON storage.objects
          FOR INSERT TO authenticated
          WITH CHECK (
            bucket_id = 'class-files'
            AND public.is_course_faculty(public.storage_course_id_from_path(name))
          )
      $p$;

      EXECUTE $p$
        CREATE POLICY class_files_delete ON storage.objects
          FOR DELETE TO authenticated
          USING (
            bucket_id = 'class-files'
            AND public.is_course_faculty(public.storage_course_id_from_path(name))
          )
      $p$;
    EXCEPTION WHEN insufficient_privilege THEN
      NULL;
    END;
  END IF;
END $$;
