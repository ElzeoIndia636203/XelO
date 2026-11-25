-- Academic events (Hackathon/Symposium/Expo/Seminar/Workshop/Culturals/Custom),
-- No-attendance day declarations even after calendar approval, session overrides,
-- classroom announcements, and hierarchy notifications.

ALTER TABLE academic_calendar_events
  DROP CONSTRAINT IF EXISTS academic_calendar_events_kind_check;

ALTER TABLE academic_calendar_events
  ADD CONSTRAINT academic_calendar_events_kind_check
  CHECK (kind IN ('internal_exam', 'regional_holiday', 'other_holiday', 'leave', 'academic_event'));

ALTER TABLE academic_calendar_events
  ADD COLUMN IF NOT EXISTS event_type text,
  ADD COLUMN IF NOT EXISTS no_attendance boolean NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS declared_by uuid REFERENCES profiles(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS declared_at timestamptz;

ALTER TABLE sessions
  ADD COLUMN IF NOT EXISTS hod_override_event text;

CREATE OR REPLACE FUNCTION hod_declare_calendar_event(
  p_from_day date,
  p_to_day date,
  p_kind text,
  p_event_type text,
  p_label text,
  p_no_attendance boolean DEFAULT false
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_me public.profiles%ROWTYPE;
  v_cal_id uuid;
  v_end_day date := coalesce(p_to_day, p_from_day);
  v_day date;
  v_clean_label text := trim(coalesce(p_label, ''));
  v_clean_type text := nullif(trim(coalesce(p_event_type, '')), '');
  v_event_name text;
  v_override_text text;
  v_dept_school text;
  v_days_count integer := 0;
  v_sessions_overridden integer := 0;
  v_notified_users integer := 0;
  v_course record;
  v_stu record;
  v_leader record;
  v_week integer;
BEGIN
  SELECT * INTO v_me FROM public.profiles WHERE id = auth.uid() AND active = true;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'forbidden';
  END IF;

  IF NOT (public.has_role('hod') OR public.has_role('super_admin')) THEN
    RAISE EXCEPTION 'forbidden';
  END IF;

  IF v_me.department_id IS NULL OR v_me.institution_id IS NULL THEN
    RAISE EXCEPTION 'forbidden';
  END IF;

  IF p_from_day IS NULL OR v_end_day < p_from_day OR (v_end_day - p_from_day) > 60 THEN
    RAISE EXCEPTION 'invalid_input';
  END IF;

  IF p_kind NOT IN ('internal_exam', 'regional_holiday', 'other_holiday', 'leave', 'academic_event') THEN
    RAISE EXCEPTION 'invalid_input';
  END IF;

  IF v_clean_label = '' AND v_clean_type IS NULL THEN
    RAISE EXCEPTION 'invalid_input';
  END IF;

  v_event_name := CASE
    WHEN v_clean_type IS NOT NULL AND v_clean_label <> '' THEN v_clean_type || ': ' || v_clean_label
    WHEN v_clean_type IS NOT NULL THEN v_clean_type
    ELSE v_clean_label
  END;
  v_override_text := 'Override by HoD for ' || v_event_name;

  SELECT id INTO v_cal_id
  FROM public.academic_calendars
  WHERE department_id = v_me.department_id;

  IF v_cal_id IS NULL THEN
    INSERT INTO public.academic_calendars (
      institution_id, department_id, first_working_day, last_working_day, saturday_rule, created_by
    ) VALUES (
      v_me.institution_id, v_me.department_id, p_from_day, greatest(p_from_day, v_end_day), 'all', v_me.id
    )
    RETURNING id INTO v_cal_id;
  END IF;

  v_day := p_from_day;
  WHILE v_day <= v_end_day LOOP
    INSERT INTO public.academic_calendar_events (
      calendar_id, institution_id, department_id, day, kind, event_type, label, no_attendance, declared_by, declared_at
    ) VALUES (
      v_cal_id, v_me.institution_id, v_me.department_id, v_day, p_kind, v_clean_type, coalesce(nullif(v_clean_label, ''), v_event_name), p_no_attendance, v_me.id, now()
    )
    ON CONFLICT (calendar_id, day) DO UPDATE SET
      kind = EXCLUDED.kind,
      event_type = EXCLUDED.event_type,
      label = EXCLUDED.label,
      no_attendance = EXCLUDED.no_attendance,
      declared_by = EXCLUDED.declared_by,
      declared_at = EXCLUDED.declared_at;

    v_days_count := v_days_count + 1;
    v_day := v_day + 1;
  END LOOP;

  IF p_no_attendance THEN
    -- Mark all scheduled sessions in this department on the declared days as HoD override
    UPDATE public.sessions s
    SET hod_override_event = v_override_text
    FROM public.courses c
    WHERE s.course_id = c.id
      AND c.department_id = v_me.department_id
      AND s.scheduled_date BETWEEN p_from_day AND v_end_day;
    GET DIAGNOSTICS v_sessions_overridden = ROW_COUNT;

    -- Notify in class (class_items announcement), faculty, and enrolled students for department courses
    FOR v_course IN
      SELECT DISTINCT c.id, c.code, c.title, c.faculty_id
      FROM public.courses c
      WHERE c.department_id = v_me.department_id
        AND c.institution_id = v_me.institution_id
    LOOP
      SELECT coalesce(max(week), 1) INTO v_week
      FROM public.class_items
      WHERE course_id = v_course.id;

      INSERT INTO public.class_items (
        institution_id, course_id, week, kind, title, body, created_by
      ) VALUES (
        v_me.institution_id,
        v_course.id,
        least(greatest(v_week, 1), 30),
        'announcement',
        'No-attendance day (' || p_from_day::text || CASE WHEN v_end_day > p_from_day THEN ' to ' || v_end_day::text ELSE '' END || '): ' || v_event_name,
        v_override_text || '. Scheduled classes/labs on this day are overridden by HoD.',
        v_me.id
      );

      IF v_course.faculty_id IS NOT NULL THEN
        PERFORM public.notify(
          v_course.faculty_id,
          'hod_no_attendance',
          'No-attendance day declared: ' || v_event_name,
          v_course.code || ' (' || p_from_day::text || CASE WHEN v_end_day > p_from_day THEN ' to ' || v_end_day::text ELSE '' END || ') — ' || v_override_text,
          '/faculty/c/' || v_course.id::text || '/plan',
          v_me.institution_id
        );
        v_notified_users := v_notified_users + 1;
      END IF;

      FOR v_stu IN
        SELECT e.student_id
        FROM public.enrollments e
        WHERE e.course_id = v_course.id
      LOOP
        PERFORM public.notify(
          v_stu.student_id,
          'hod_no_attendance',
          'No-attendance day declared: ' || v_event_name,
          v_course.code || ' (' || p_from_day::text || CASE WHEN v_end_day > p_from_day THEN ' to ' || v_end_day::text ELSE '' END || ') — ' || v_override_text,
          '/student/c/' || v_course.id::text || '/classroom',
          v_me.institution_id
        );
        v_notified_users := v_notified_users + 1;
      END LOOP;
    END LOOP;

    -- Notify higher hierarchy: respective Dean, CoE, and VC/Principal in the institution
    SELECT school INTO v_dept_school FROM public.departments WHERE id = v_me.department_id;
    FOR v_leader IN
      SELECT p.id
      FROM public.profiles p
      WHERE p.institution_id = v_me.institution_id
        AND p.active = true
        AND p.id <> v_me.id
        AND (
          'coe' = ANY(coalesce(p.roles, ARRAY[p.role]))
          OR 'vc' = ANY(coalesce(p.roles, ARRAY[p.role]))
          OR (
            'dean' = ANY(coalesce(p.roles, ARRAY[p.role]))
            AND (v_dept_school IS NULL OR p.school IS NULL OR p.school = '' OR p.school = v_dept_school)
          )
        )
    LOOP
      PERFORM public.notify(
        v_leader.id,
        'hod_no_attendance',
        'No-attendance day declared by HoD: ' || v_event_name,
        'Date: ' || p_from_day::text || CASE WHEN v_end_day > p_from_day THEN ' to ' || v_end_day::text ELSE '' END || ' · ' || v_override_text,
        '/oversight',
        v_me.institution_id
      );
      v_notified_users := v_notified_users + 1;
    END LOOP;
  END IF;

  INSERT INTO public.audit_log (
    institution_id, actor_id, action, entity_type, entity_id, details
  ) VALUES (
    v_me.institution_id,
    v_me.id,
    'hod_declare_calendar_event',
    'academic_calendar',
    v_cal_id,
    jsonb_build_object(
      'from_day', p_from_day,
      'to_day', v_end_day,
      'kind', p_kind,
      'event_type', v_clean_type,
      'label', v_event_name,
      'no_attendance', p_no_attendance,
      'sessions_overridden', v_sessions_overridden,
      'notified_users', v_notified_users
    )
  );

  RETURN jsonb_build_object(
    'calendar_id', v_cal_id,
    'days_saved', v_days_count,
    'sessions_overridden', v_sessions_overridden,
    'notified_users', v_notified_users,
    'override_text', CASE WHEN p_no_attendance THEN v_override_text ELSE null END
  );
END;
$$;

REVOKE ALL ON FUNCTION hod_declare_calendar_event(date, date, text, text, text, boolean) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION hod_declare_calendar_event(date, date, text, text, text, boolean) TO authenticated;
