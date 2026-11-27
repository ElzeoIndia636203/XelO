-- XeIO AI Proctoring Rulebook (56 rules, 3 levels, S0-S3 severity, Level 2 Moderate default)
-- Applies to all assessments: End-Sem (assessments + exam_papers) and Instant Coding Tests (instant_tests + instant_test_attempts).

-- 1) Assessment-level proctoring configuration (default Level 2 = Moderate)
ALTER TABLE public.assessments
  ADD COLUMN IF NOT EXISTS proctor_level smallint NOT NULL DEFAULT 2 CHECK (proctor_level IN (1, 2, 3)),
  ADD COLUMN IF NOT EXISTS proctor_media jsonb NOT NULL DEFAULT '{"camera":false,"microphone":false,"screenShare":true}'::jsonb,
  ADD COLUMN IF NOT EXISTS proctor_level_reason text NOT NULL DEFAULT '',
  ADD COLUMN IF NOT EXISTS proctor_config jsonb NOT NULL DEFAULT '{
    "version": 1,
    "level": 2,
    "media": { "camera": false, "microphone": false, "screenShare": true },
    "ladder": { "toast": 1, "modal": 2, "flag": 3, "visit": 5 },
    "score": { "start": 100, "clean": 85, "reviewRequired": 60, "dedupeSeconds": 60 },
    "sampling": { "faceMs": 1000, "landmarksMs": 1000, "objectsMs": 3000, "identityMs": 60000, "screenFrameMs": 10000, "heartbeatMs": 15000, "autosaveMs": 10000 }
  }'::jsonb;

ALTER TABLE public.instant_tests
  ADD COLUMN IF NOT EXISTS proctor_level smallint NOT NULL DEFAULT 2 CHECK (proctor_level IN (1, 2, 3)),
  ADD COLUMN IF NOT EXISTS proctor_media jsonb NOT NULL DEFAULT '{"camera":false,"microphone":false,"screenShare":true}'::jsonb,
  ADD COLUMN IF NOT EXISTS proctor_level_reason text NOT NULL DEFAULT '',
  ADD COLUMN IF NOT EXISTS proctor_config jsonb NOT NULL DEFAULT '{
    "version": 1,
    "level": 2,
    "media": { "camera": false, "microphone": false, "screenShare": true },
    "ladder": { "toast": 1, "modal": 2, "flag": 3, "visit": 5 },
    "score": { "start": 100, "clean": 85, "reviewRequired": 60, "dedupeSeconds": 60 },
    "sampling": { "faceMs": 1000, "landmarksMs": 1000, "objectsMs": 3000, "identityMs": 60000, "screenFrameMs": 10000, "heartbeatMs": 15000, "autosaveMs": 10000 }
  }'::jsonb;

-- 2) Attempt-level server state (warning ladder, integrity score, holds, start record, review decision)
ALTER TABLE public.exam_papers
  ADD COLUMN IF NOT EXISTS integrity_score numeric NOT NULL DEFAULT 100,
  ADD COLUMN IF NOT EXISTS warning_count integer NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS active_hold_rule text,
  ADD COLUMN IF NOT EXISTS proctor_degraded boolean NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS start_record jsonb NOT NULL DEFAULT '{}'::jsonb,
  ADD COLUMN IF NOT EXISTS start_selfie_path text,
  ADD COLUMN IF NOT EXISTS offline_seconds integer NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS last_heartbeat_at timestamptz,
  ADD COLUMN IF NOT EXISTS review_decision text NOT NULL DEFAULT 'pending' CHECK (review_decision IN ('pending', 'no_issue', 'minor', 'misconduct_suspected')),
  ADD COLUMN IF NOT EXISTS review_note text NOT NULL DEFAULT '',
  ADD COLUMN IF NOT EXISTS second_reviewer_id uuid REFERENCES public.profiles(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS editor_event_log jsonb NOT NULL DEFAULT '[]'::jsonb,
  ADD COLUMN IF NOT EXISTS ended_reason text;

ALTER TABLE public.instant_test_attempts
  ADD COLUMN IF NOT EXISTS integrity_score numeric NOT NULL DEFAULT 100,
  ADD COLUMN IF NOT EXISTS warning_count integer NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS flagged boolean NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS active_hold_rule text,
  ADD COLUMN IF NOT EXISTS proctor_degraded boolean NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS start_record jsonb NOT NULL DEFAULT '{}'::jsonb,
  ADD COLUMN IF NOT EXISTS start_selfie_path text,
  ADD COLUMN IF NOT EXISTS offline_seconds integer NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS last_heartbeat_at timestamptz,
  ADD COLUMN IF NOT EXISTS deadline timestamptz,
  ADD COLUMN IF NOT EXISTS extra_minutes integer NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS review_decision text NOT NULL DEFAULT 'pending' CHECK (review_decision IN ('pending', 'no_issue', 'minor', 'misconduct_suspected')),
  ADD COLUMN IF NOT EXISTS review_note text NOT NULL DEFAULT '',
  ADD COLUMN IF NOT EXISTS second_reviewer_id uuid REFERENCES public.profiles(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS editor_event_log jsonb NOT NULL DEFAULT '[]'::jsonb,
  ADD COLUMN IF NOT EXISTS ended_reason text;

-- 3) Approved student accommodations per assessment
CREATE TABLE IF NOT EXISTS public.student_accommodations (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  institution_id uuid NOT NULL REFERENCES public.institutions(id) ON DELETE CASCADE,
  student_id uuid NOT NULL REFERENCES public.profiles(id) ON DELETE CASCADE,
  assessment_type text NOT NULL CHECK (assessment_type IN ('endsem', 'instant')),
  assessment_id uuid NOT NULL,
  extra_time_minutes integer NOT NULL DEFAULT 0 CHECK (extra_time_minutes >= 0),
  relax_screen_reader boolean NOT NULL DEFAULT false,
  scribe_reader boolean NOT NULL DEFAULT false,
  allow_medical_breaks boolean NOT NULL DEFAULT false,
  no_camera boolean NOT NULL DEFAULT false,
  note text NOT NULL DEFAULT '',
  approved_by uuid REFERENCES public.profiles(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (assessment_type, assessment_id, student_id)
);

ALTER TABLE public.student_accommodations ENABLE ROW LEVEL SECURITY;
GRANT SELECT ON public.student_accommodations TO authenticated;
GRANT ALL ON public.student_accommodations TO service_role;

DROP POLICY IF EXISTS student_accommodations_read ON public.student_accommodations;
CREATE POLICY student_accommodations_read ON public.student_accommodations
  FOR SELECT TO authenticated
  USING (
    student_id = me()
    OR is_super_admin()
    OR (institution_id = my_institution() AND my_role() IN ('vc', 'coe', 'dean', 'hod', 'faculty'))
  );

-- 4) Extend proctor_events to support rulebook IDs, S0-S3 levels, instant attempts, and review
ALTER TABLE public.proctor_events
  ALTER COLUMN paper_id DROP NOT NULL,
  ALTER COLUMN event_type SET DEFAULT 'tab_switch';

ALTER TABLE public.proctor_events
  ADD COLUMN IF NOT EXISTS assessment_type text NOT NULL DEFAULT 'endsem' CHECK (assessment_type IN ('endsem', 'instant')),
  ADD COLUMN IF NOT EXISTS instant_attempt_id uuid REFERENCES public.instant_test_attempts(id) ON DELETE CASCADE,
  ADD COLUMN IF NOT EXISTS rule_id text NOT NULL DEFAULT 'BL-02',
  ADD COLUMN IF NOT EXISTS level text NOT NULL DEFAULT 'S1' CHECK (level IN ('S0', 'S1', 'S2', 'S3')),
  ADD COLUMN IF NOT EXISTS confidence numeric,
  ADD COLUMN IF NOT EXISTS duration_sec integer NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS question_id text,
  ADD COLUMN IF NOT EXISTS detail_json jsonb NOT NULL DEFAULT '{}'::jsonb,
  ADD COLUMN IF NOT EXISTS screen_frame_path text,
  ADD COLUMN IF NOT EXISTS review_outcome text CHECK (review_outcome IN ('cleared', 'confirmed')),
  ADD COLUMN IF NOT EXISTS review_reason text,
  ADD COLUMN IF NOT EXISTS second_reviewer_id uuid REFERENCES public.profiles(id) ON DELETE SET NULL;

CREATE INDEX IF NOT EXISTS idx_proctor_events_instant ON public.proctor_events(instant_attempt_id, at DESC);
CREATE INDEX IF NOT EXISTS idx_proctor_events_rule ON public.proctor_events(rule_id, at DESC);

-- 5) Configure proctoring level & media per assessment
CREATE OR REPLACE FUNCTION faculty_set_proctor_config(
  p_assessment_type text,
  p_assessment_id uuid,
  p_level integer,
  p_camera boolean DEFAULT false,
  p_microphone boolean DEFAULT false,
  p_reason text DEFAULT '',
  p_config jsonb DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_course_id uuid;
  v_locked boolean := false;
  v_media jsonb;
  v_cfg jsonb;
BEGIN
  IF p_assessment_type NOT IN ('endsem', 'instant') OR p_level NOT IN (1, 2, 3) THEN
    RAISE EXCEPTION 'invalid_input';
  END IF;

  IF p_assessment_type = 'endsem' THEN
    SELECT course_id, rules_locked INTO v_course_id, v_locked
    FROM public.assessments WHERE id = p_assessment_id;
    IF NOT FOUND THEN RAISE EXCEPTION 'not_found'; END IF;
    IF NOT (is_course_faculty(v_course_id) OR is_super_admin()) THEN RAISE EXCEPTION 'forbidden'; END IF;
    IF v_locked THEN RAISE EXCEPTION 'rules_locked'; END IF;
    IF p_level IN (1, 2) AND trim(coalesce(p_reason, '')) = '' THEN
      RAISE EXCEPTION 'remark_required';
    END IF;
  ELSE
    SELECT course_id, (status = 'finalized') INTO v_course_id, v_locked
    FROM public.instant_tests WHERE id = p_assessment_id;
    IF NOT FOUND THEN RAISE EXCEPTION 'not_found'; END IF;
    IF NOT (is_course_faculty(v_course_id) OR is_super_admin()) THEN RAISE EXCEPTION 'forbidden'; END IF;
    IF v_locked THEN RAISE EXCEPTION 'not_editable'; END IF;
  END IF;

  v_media := CASE p_level
    WHEN 3 THEN jsonb_build_object('camera', true, 'microphone', true, 'screenShare', true)
    WHEN 2 THEN jsonb_build_object('camera', coalesce(p_camera, false), 'microphone', coalesce(p_microphone, false), 'screenShare', true)
    ELSE jsonb_build_object('camera', false, 'microphone', false, 'screenShare', false)
  END;

  v_cfg := coalesce(p_config, jsonb_build_object(
    'version', 1,
    'level', p_level,
    'media', v_media,
    'levelReason', nullif(trim(coalesce(p_reason, '')), ''),
    'ladder', jsonb_build_object('toast', 1, 'modal', 2, 'flag', 3, 'visit', 5),
    'score', jsonb_build_object('start', 100, 'clean', 85, 'reviewRequired', 60, 'dedupeSeconds', 60),
    'sampling', jsonb_build_object('faceMs', 1000, 'landmarksMs', 1000, 'objectsMs', 3000, 'identityMs', 60000, 'screenFrameMs', 10000, 'heartbeatMs', 15000, 'autosaveMs', 10000)
  ));

  IF p_assessment_type = 'endsem' THEN
    UPDATE public.assessments
    SET proctor_level = p_level,
        proctor_media = v_media,
        proctor_level_reason = trim(coalesce(p_reason, '')),
        proctor_config = v_cfg
    WHERE id = p_assessment_id;
  ELSE
    UPDATE public.instant_tests
    SET proctor_level = p_level,
        proctor_media = v_media,
        proctor_level_reason = trim(coalesce(p_reason, '')),
        proctor_config = v_cfg
    WHERE id = p_assessment_id;
  END IF;

  RETURN jsonb_build_object('level', p_level, 'media', v_media, 'config', v_cfg);
END;
$$;

-- 6) Faculty sets student accommodation
CREATE OR REPLACE FUNCTION faculty_set_student_accommodation(
  p_assessment_type text,
  p_assessment_id uuid,
  p_student_id uuid,
  p_extra_time_minutes integer DEFAULT 0,
  p_relax_screen_reader boolean DEFAULT false,
  p_scribe_reader boolean DEFAULT false,
  p_allow_medical_breaks boolean DEFAULT false,
  p_no_camera boolean DEFAULT false,
  p_note text DEFAULT ''
)
RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_course_id uuid;
  v_inst_id uuid;
  v_id uuid;
BEGIN
  IF p_assessment_type NOT IN ('endsem', 'instant') THEN
    RAISE EXCEPTION 'invalid_input';
  END IF;

  IF p_assessment_type = 'endsem' THEN
    SELECT course_id, institution_id INTO v_course_id, v_inst_id FROM public.assessments WHERE id = p_assessment_id;
  ELSE
    SELECT course_id, institution_id INTO v_course_id, v_inst_id FROM public.instant_tests WHERE id = p_assessment_id;
  END IF;
  IF NOT FOUND THEN RAISE EXCEPTION 'not_found'; END IF;
  IF NOT (is_course_faculty(v_course_id) OR is_super_admin()) THEN RAISE EXCEPTION 'forbidden'; END IF;

  INSERT INTO public.student_accommodations (
    institution_id, student_id, assessment_type, assessment_id,
    extra_time_minutes, relax_screen_reader, scribe_reader, allow_medical_breaks, no_camera, note, approved_by
  ) VALUES (
    v_inst_id, p_student_id, p_assessment_type, p_assessment_id,
    greatest(0, coalesce(p_extra_time_minutes, 0)), coalesce(p_relax_screen_reader, false),
    coalesce(p_scribe_reader, false), coalesce(p_allow_medical_breaks, false), coalesce(p_no_camera, false),
    trim(coalesce(p_note, '')), me()
  )
  ON CONFLICT (assessment_type, assessment_id, student_id) DO UPDATE
    SET extra_time_minutes = EXCLUDED.extra_time_minutes,
        relax_screen_reader = EXCLUDED.relax_screen_reader,
        scribe_reader = EXCLUDED.scribe_reader,
        allow_medical_breaks = EXCLUDED.allow_medical_breaks,
        no_camera = EXCLUDED.no_camera,
        note = EXCLUDED.note,
        approved_by = me()
  RETURNING id INTO v_id;

  RETURN v_id;
END;
$$;

-- 7) Save student secure-check start record & selfie
CREATE OR REPLACE FUNCTION student_save_proctor_start(
  p_assessment_type text,
  p_attempt_id uuid,
  p_start_record jsonb,
  p_selfie_path text DEFAULT NULL
)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_student_id uuid;
BEGIN
  IF p_assessment_type = 'endsem' THEN
    SELECT student_id INTO v_student_id FROM public.exam_papers WHERE id = p_attempt_id;
    IF NOT FOUND THEN RAISE EXCEPTION 'not_found'; END IF;
    IF v_student_id <> me() THEN RAISE EXCEPTION 'forbidden'; END IF;
    UPDATE public.exam_papers
    SET start_record = coalesce(p_start_record, '{}'::jsonb),
        start_selfie_path = coalesce(p_selfie_path, start_selfie_path),
        last_heartbeat_at = now()
    WHERE id = p_attempt_id;
  ELSE
    SELECT student_id INTO v_student_id FROM public.instant_test_attempts WHERE id = p_attempt_id;
    IF NOT FOUND THEN RAISE EXCEPTION 'not_found'; END IF;
    IF v_student_id <> me() THEN RAISE EXCEPTION 'forbidden'; END IF;
    UPDATE public.instant_test_attempts
    SET start_record = coalesce(p_start_record, '{}'::jsonb),
        start_selfie_path = coalesce(p_selfie_path, start_selfie_path),
        last_heartbeat_at = now()
    WHERE id = p_attempt_id;
  END IF;
END;
$$;

-- 8) Server-owned proctor event logger (60s dedupe, warning ladder, integrity score, S3 holds)
CREATE OR REPLACE FUNCTION log_proctor_event_v2(
  p_assessment_type text,
  p_attempt_id uuid,
  p_rule_id text,
  p_level text,
  p_confidence numeric DEFAULT NULL,
  p_duration_sec integer DEFAULT 0,
  p_question_id text DEFAULT NULL,
  p_detail jsonb DEFAULT '{}'::jsonb,
  p_snapshot_path text DEFAULT NULL,
  p_screen_frame_path text DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_student_id uuid;
  v_inst_id uuid;
  v_course_id uuid;
  v_faculty_id uuid;
  v_warn integer := 0;
  v_score numeric := 100;
  v_flagged boolean := false;
  v_hold text := NULL;
  v_dedupe boolean := false;
  v_deduct numeric := 0;
  v_event_id uuid;
  v_legacy_kind proctor_event_type;
  v_sev integer;
BEGIN
  IF p_assessment_type NOT IN ('endsem', 'instant') OR p_level NOT IN ('S0', 'S1', 'S2', 'S3') THEN
    RAISE EXCEPTION 'invalid_input';
  END IF;

  IF p_assessment_type = 'endsem' THEN
    SELECT ep.student_id, ep.institution_id, a.course_id, ep.warning_count, ep.integrity_score, ep.flagged, ep.active_hold_rule
    INTO v_student_id, v_inst_id, v_course_id, v_warn, v_score, v_flagged, v_hold
    FROM public.exam_papers ep
    JOIN public.assessments a ON a.id = ep.assessment_id
    WHERE ep.id = p_attempt_id;
  ELSE
    SELECT ita.student_id, ita.institution_id, it.course_id, ita.warning_count, ita.integrity_score, ita.flagged, ita.active_hold_rule
    INTO v_student_id, v_inst_id, v_course_id, v_warn, v_score, v_flagged, v_hold
    FROM public.instant_test_attempts ita
    JOIN public.instant_tests it ON it.id = ita.test_id
    WHERE ita.id = p_attempt_id;
  END IF;

  IF NOT FOUND THEN RAISE EXCEPTION 'not_found'; END IF;
  IF v_student_id <> me() THEN RAISE EXCEPTION 'forbidden'; END IF;

  -- Check 60-second rule dedupe
  SELECT EXISTS (
    SELECT 1 FROM public.proctor_events pe
    WHERE pe.assessment_type = p_assessment_type
      AND ((p_assessment_type = 'endsem' AND pe.paper_id = p_attempt_id) OR (p_assessment_type = 'instant' AND pe.instant_attempt_id = p_attempt_id))
      AND pe.rule_id = p_rule_id
      AND pe.at > now() - interval '60 seconds'
  ) INTO v_dedupe;

  IF NOT v_dedupe THEN
    v_deduct := CASE p_level
      WHEN 'S1' THEN 3
      WHEN 'S2' THEN 15
      WHEN 'S3' THEN 5
      ELSE 0
    END;
    v_score := greatest(0, v_score - v_deduct);
  END IF;

  IF p_level IN ('S1', 'S2', 'S3') AND NOT v_dedupe THEN
    v_warn := v_warn + 1;
  END IF;

  IF v_warn >= 3 OR p_level = 'S2' THEN
    v_flagged := true;
  END IF;

  IF p_level = 'S3' THEN
    v_hold := p_rule_id;
  END IF;

  v_legacy_kind := CASE
    WHEN p_rule_id = 'BL-01' THEN 'fullscreen_exit'::proctor_event_type
    WHEN p_rule_id IN ('BL-02', 'BL-03') THEN 'tab_switch'::proctor_event_type
    WHEN p_rule_id IN ('BL-04', 'CB-01') THEN 'copy_paste'::proctor_event_type
    WHEN p_rule_id = 'BL-08' THEN 'devtools'::proctor_event_type
    WHEN p_rule_id = 'AI-02' THEN 'multi_face'::proctor_event_type
    WHEN p_rule_id IN ('AI-01', 'AI-03') THEN 'no_face'::proctor_event_type
    WHEN p_rule_id IN ('AI-10', 'BL-12', 'AU-03', 'SC-03') THEN 'camera_off'::proctor_event_type
    WHEN p_rule_id IN ('RS-03', 'RS-04') THEN 'disconnect'::proctor_event_type
    ELSE 'tab_switch'::proctor_event_type
  END;

  v_sev := CASE p_level WHEN 'S3' THEN 3 WHEN 'S2' THEN 2 ELSE 1 END;

  INSERT INTO public.proctor_events (
    institution_id, paper_id, instant_attempt_id, assessment_type,
    event_type, severity, rule_id, level, confidence, duration_sec,
    question_id, detail, detail_json, snapshot_path, screen_frame_path
  ) VALUES (
    v_inst_id,
    CASE WHEN p_assessment_type = 'endsem' THEN p_attempt_id ELSE NULL END,
    CASE WHEN p_assessment_type = 'instant' THEN p_attempt_id ELSE NULL END,
    p_assessment_type,
    v_legacy_kind, v_sev, p_rule_id, p_level, p_confidence, greatest(0, coalesce(p_duration_sec, 0)),
    p_question_id, coalesce(p_detail->>'message', p_rule_id), coalesce(p_detail, '{}'::jsonb),
    p_snapshot_path, p_screen_frame_path
  )
  RETURNING id INTO v_event_id;

  IF p_assessment_type = 'endsem' THEN
    UPDATE public.exam_papers
    SET warning_count = v_warn,
        integrity_score = v_score,
        flagged = v_flagged,
        active_hold_rule = v_hold
    WHERE id = p_attempt_id;
  ELSE
    UPDATE public.instant_test_attempts
    SET warning_count = v_warn,
        integrity_score = v_score,
        flagged = v_flagged,
        active_hold_rule = v_hold
    WHERE id = p_attempt_id;
  END IF;

  IF (v_warn = 3 OR v_warn >= 5 OR p_level IN ('S2', 'S3')) AND NOT v_dedupe THEN
    SELECT faculty_id INTO v_faculty_id FROM public.courses WHERE id = v_course_id;
    IF v_faculty_id IS NOT NULL THEN
      PERFORM public.notify(
        v_faculty_id,
        'proctor_alert',
        'Proctor ' || p_level || ': ' || p_rule_id,
        CASE
          WHEN v_warn >= 5 THEN '5+ warnings reached — visit seat or check student attempt.'
          WHEN p_level = 'S3' THEN 'S3 hold triggered (' || p_rule_id || ').'
          WHEN p_level = 'S2' THEN 'S2 major event (' || p_rule_id || ') flagged for review.'
          ELSE '3rd warning reached — attempt flagged for review.'
        END,
        '/app/faculty/c/' || v_course_id || CASE WHEN p_assessment_type = 'endsem' THEN '/assessments' ELSE '/instant' END,
        v_inst_id
      );
    END IF;
  END IF;

  RETURN jsonb_build_object(
    'event_id', v_event_id,
    'level', p_level,
    'deduped', v_dedupe,
    'warning_count', v_warn,
    'integrity_score', v_score,
    'flagged', v_flagged,
    'active_hold_rule', v_hold,
    'ladder_action', CASE
      WHEN p_level = 'S3' THEN 'hold'
      WHEN p_level = 'S2' THEN 'modal'
      WHEN p_level = 'S1' AND v_warn >= 2 THEN 'modal'
      WHEN p_level = 'S1' THEN 'toast'
      ELSE 'none'
    END
  );
END;
$$;

-- 9) Heartbeat (RS-03 / RS-04)
CREATE OR REPLACE FUNCTION proctor_heartbeat(
  p_assessment_type text,
  p_attempt_id uuid,
  p_degraded boolean DEFAULT false
)
RETURNS timestamptz
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_student_id uuid;
BEGIN
  IF p_assessment_type = 'endsem' THEN
    SELECT student_id INTO v_student_id FROM public.exam_papers WHERE id = p_attempt_id;
    IF NOT FOUND THEN RAISE EXCEPTION 'not_found'; END IF;
    IF v_student_id <> me() THEN RAISE EXCEPTION 'forbidden'; END IF;
    UPDATE public.exam_papers
    SET last_heartbeat_at = now(),
        proctor_degraded = proctor_degraded OR coalesce(p_degraded, false)
    WHERE id = p_attempt_id;
  ELSE
    SELECT student_id INTO v_student_id FROM public.instant_test_attempts WHERE id = p_attempt_id;
    IF NOT FOUND THEN RAISE EXCEPTION 'not_found'; END IF;
    IF v_student_id <> me() THEN RAISE EXCEPTION 'forbidden'; END IF;
    UPDATE public.instant_test_attempts
    SET last_heartbeat_at = now(),
        proctor_degraded = proctor_degraded OR coalesce(p_degraded, false)
    WHERE id = p_attempt_id;
  END IF;
  RETURN now();
END;
$$;

-- 10) Invigilator controls (release hold, grant extra time, add note, end attempt with reason)
CREATE OR REPLACE FUNCTION invigilator_control_attempt(
  p_assessment_type text,
  p_attempt_id uuid,
  p_action text,
  p_extra_minutes integer DEFAULT 0,
  p_note text DEFAULT ''
)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_course_id uuid;
  v_inst_id uuid;
BEGIN
  IF p_action NOT IN ('release_hold', 'grant_extra_time', 'add_note', 'end_attempt') THEN
    RAISE EXCEPTION 'invalid_input';
  END IF;
  IF p_action = 'end_attempt' AND trim(coalesce(p_note, '')) = '' THEN
    RAISE EXCEPTION 'remark_required';
  END IF;

  IF p_assessment_type = 'endsem' THEN
    SELECT a.course_id, ep.institution_id INTO v_course_id, v_inst_id
    FROM public.exam_papers ep JOIN public.assessments a ON a.id = ep.assessment_id
    WHERE ep.id = p_attempt_id;
  ELSE
    SELECT it.course_id, ita.institution_id INTO v_course_id, v_inst_id
    FROM public.instant_test_attempts ita JOIN public.instant_tests it ON it.id = ita.test_id
    WHERE ita.id = p_attempt_id;
  END IF;
  IF NOT FOUND THEN RAISE EXCEPTION 'not_found'; END IF;
  IF NOT (is_course_faculty(v_course_id) OR is_super_admin()) THEN RAISE EXCEPTION 'forbidden'; END IF;

  IF p_assessment_type = 'endsem' THEN
    IF p_action = 'release_hold' THEN
      UPDATE public.exam_papers SET active_hold_rule = NULL WHERE id = p_attempt_id;
    ELSIF p_action = 'grant_extra_time' THEN
      UPDATE public.exam_papers
      SET extra_minutes = extra_minutes + greatest(1, p_extra_minutes),
          deadline = deadline + make_interval(mins => greatest(1, p_extra_minutes))
      WHERE id = p_attempt_id;
    ELSIF p_action = 'add_note' THEN
      UPDATE public.exam_papers SET review_note = trim(coalesce(p_note, '')) WHERE id = p_attempt_id;
    ELSIF p_action = 'end_attempt' THEN
      UPDATE public.exam_papers SET submitted_at = coalesce(submitted_at, now()), ended_reason = trim(p_note) WHERE id = p_attempt_id;
    END IF;
  ELSE
    IF p_action = 'release_hold' THEN
      UPDATE public.instant_test_attempts SET active_hold_rule = NULL WHERE id = p_attempt_id;
    ELSIF p_action = 'grant_extra_time' THEN
      UPDATE public.instant_test_attempts
      SET extra_minutes = extra_minutes + greatest(1, p_extra_minutes),
          deadline = coalesce(deadline, now()) + make_interval(mins => greatest(1, p_extra_minutes))
      WHERE id = p_attempt_id;
    ELSIF p_action = 'add_note' THEN
      UPDATE public.instant_test_attempts SET review_note = trim(coalesce(p_note, '')) WHERE id = p_attempt_id;
    ELSIF p_action = 'end_attempt' THEN
      UPDATE public.instant_test_attempts SET submitted_at = coalesce(submitted_at, now()), ended_reason = trim(p_note) WHERE id = p_attempt_id;
    END IF;
  END IF;

  PERFORM public.audit(
    'invigilator_' || p_action,
    p_assessment_type || '_attempt',
    p_attempt_id::text,
    jsonb_build_object('extra_minutes', p_extra_minutes, 'note', trim(coalesce(p_note, ''))),
    v_inst_id
  );
END;
$$;

-- 11) Review individual proctor event & final attempt decision
CREATE OR REPLACE FUNCTION faculty_review_proctor_event(
  p_event_id uuid,
  p_outcome text,
  p_reason text DEFAULT ''
)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_ev public.proctor_events%ROWTYPE;
  v_course_id uuid;
BEGIN
  IF p_outcome NOT IN ('cleared', 'confirmed') THEN
    RAISE EXCEPTION 'invalid_input';
  END IF;
  IF p_outcome = 'cleared' AND trim(coalesce(p_reason, '')) = '' THEN
    RAISE EXCEPTION 'remark_required';
  END IF;

  SELECT * INTO v_ev FROM public.proctor_events WHERE id = p_event_id;
  IF NOT FOUND THEN RAISE EXCEPTION 'not_found'; END IF;

  IF v_ev.assessment_type = 'endsem' THEN
    SELECT a.course_id INTO v_course_id
    FROM public.exam_papers ep JOIN public.assessments a ON a.id = ep.assessment_id
    WHERE ep.id = v_ev.paper_id;
  ELSE
    SELECT it.course_id INTO v_course_id
    FROM public.instant_test_attempts ita JOIN public.instant_tests it ON it.id = ita.test_id
    WHERE ita.id = v_ev.instant_attempt_id;
  END IF;

  IF NOT (is_course_faculty(v_course_id) OR is_super_admin()) THEN
    RAISE EXCEPTION 'forbidden';
  END IF;

  UPDATE public.proctor_events
  SET reviewed_by = me(),
      reviewed_at = now(),
      review_outcome = p_outcome,
      review_reason = trim(coalesce(p_reason, ''))
  WHERE id = p_event_id;
END;
$$;

CREATE OR REPLACE FUNCTION faculty_decide_proctored_attempt(
  p_assessment_type text,
  p_attempt_id uuid,
  p_decision text,
  p_note text DEFAULT '',
  p_second_reviewer_id uuid DEFAULT NULL
)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_course_id uuid;
  v_inst_id uuid;
BEGIN
  IF p_decision NOT IN ('no_issue', 'minor', 'misconduct_suspected') THEN
    RAISE EXCEPTION 'invalid_input';
  END IF;
  IF p_decision = 'misconduct_suspected' AND p_second_reviewer_id IS NULL THEN
    RAISE EXCEPTION 'second_reviewer_required';
  END IF;

  IF p_assessment_type = 'endsem' THEN
    SELECT a.course_id, ep.institution_id INTO v_course_id, v_inst_id
    FROM public.exam_papers ep JOIN public.assessments a ON a.id = ep.assessment_id
    WHERE ep.id = p_attempt_id;
  ELSE
    SELECT it.course_id, ita.institution_id INTO v_course_id, v_inst_id
    FROM public.instant_test_attempts ita JOIN public.instant_tests it ON it.id = ita.test_id
    WHERE ita.id = p_attempt_id;
  END IF;
  IF NOT FOUND THEN RAISE EXCEPTION 'not_found'; END IF;
  IF NOT (is_course_faculty(v_course_id) OR is_super_admin()) THEN RAISE EXCEPTION 'forbidden'; END IF;

  IF p_assessment_type = 'endsem' THEN
    UPDATE public.exam_papers
    SET review_decision = p_decision,
        review_note = trim(coalesce(p_note, '')),
        second_reviewer_id = p_second_reviewer_id
    WHERE id = p_attempt_id;
  ELSE
    UPDATE public.instant_test_attempts
    SET review_decision = p_decision,
        review_note = trim(coalesce(p_note, '')),
        second_reviewer_id = p_second_reviewer_id
    WHERE id = p_attempt_id;
  END IF;

  PERFORM public.audit(
    'proctor_review_decision',
    p_assessment_type || '_attempt',
    p_attempt_id::text,
    jsonb_build_object('decision', p_decision, 'second_reviewer_id', p_second_reviewer_id, 'note', trim(coalesce(p_note, ''))),
    v_inst_id
  );
END;
$$;

GRANT EXECUTE ON FUNCTION faculty_set_proctor_config(text, uuid, integer, boolean, boolean, text, jsonb) TO authenticated;
GRANT EXECUTE ON FUNCTION faculty_set_student_accommodation(text, uuid, uuid, integer, boolean, boolean, boolean, boolean, text) TO authenticated;
GRANT EXECUTE ON FUNCTION student_save_proctor_start(text, uuid, jsonb, text) TO authenticated;
GRANT EXECUTE ON FUNCTION log_proctor_event_v2(text, uuid, text, text, numeric, integer, text, jsonb, text, text) TO authenticated;
GRANT EXECUTE ON FUNCTION proctor_heartbeat(text, uuid, boolean) TO authenticated;
GRANT EXECUTE ON FUNCTION invigilator_control_attempt(text, uuid, text, integer, text) TO authenticated;
GRANT EXECUTE ON FUNCTION faculty_review_proctor_event(uuid, text, text) TO authenticated;
GRANT EXECUTE ON FUNCTION faculty_decide_proctored_attempt(text, uuid, text, text, uuid) TO authenticated;
