-- Instant Coding Test Live Monitoring, 2nd-Breach Auto-Submission, 2-Reset Limit, and Cheating Termination

ALTER TABLE public.instant_test_attempts
  ADD COLUMN IF NOT EXISTS reset_count integer NOT NULL DEFAULT 0 CHECK (reset_count >= 0),
  ADD COLUMN IF NOT EXISTS auto_submitted_breach boolean NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS cheating_marked boolean NOT NULL DEFAULT false;

-- Update log_proctor_event_v2: for instant coding tests, 2nd breach (warning_count >= 2) auto-submits the attempt.
-- End-Sem assessments continue to follow the 3-warning flag-only Rulebook.
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
  v_auto_submitted boolean := false;
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

  IF p_assessment_type = 'instant' AND v_warn >= 2 AND p_level IN ('S1', 'S2', 'S3') THEN
    v_auto_submitted := true;
    v_flagged := true;
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
        active_hold_rule = CASE WHEN v_auto_submitted THEN NULL ELSE v_hold END,
        submitted_at = CASE WHEN v_auto_submitted THEN coalesce(submitted_at, now()) ELSE submitted_at END,
        auto_submitted_breach = auto_submitted_breach OR v_auto_submitted,
        ended_reason = CASE
          WHEN v_auto_submitted AND ended_reason IS NULL
          THEN 'Auto-submitted on 2nd breach (' || p_rule_id || ')'
          ELSE ended_reason
        END
    WHERE id = p_attempt_id;
  END IF;

  IF (v_auto_submitted OR v_warn = 3 OR v_warn >= 5 OR p_level IN ('S2', 'S3')) AND NOT v_dedupe THEN
    SELECT faculty_id INTO v_faculty_id FROM public.courses WHERE id = v_course_id;
    IF v_faculty_id IS NOT NULL THEN
      PERFORM public.notify(
        v_faculty_id,
        'proctor_alert',
        CASE WHEN v_auto_submitted THEN 'Auto-submitted (2nd breach): ' || p_rule_id ELSE 'Proctor ' || p_level || ': ' || p_rule_id END,
        CASE
          WHEN v_auto_submitted THEN 'Student attempt auto-submitted on 2nd breach (' || p_rule_id || ').'
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
    'active_hold_rule', CASE WHEN v_auto_submitted THEN NULL ELSE v_hold END,
    'auto_submitted', v_auto_submitted,
    'ladder_action', CASE
      WHEN v_auto_submitted THEN 'auto_submitted'
      WHEN p_level = 'S3' THEN 'hold'
      WHEN p_level = 'S2' THEN 'modal'
      WHEN p_level = 'S1' AND v_warn >= 2 THEN 'modal'
      WHEN p_level = 'S1' THEN 'toast'
      ELSE 'none'
    END
  );
END;
$$;

-- Faculty can reset a student's instant test attempt at most 2 times
CREATE OR REPLACE FUNCTION faculty_reset_instant_attempt(
  p_attempt_id uuid,
  p_reason text DEFAULT ''
)
RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_att public.instant_test_attempts%ROWTYPE;
  v_t public.instant_tests%ROWTYPE;
  v_next_reset integer;
BEGIN
  SELECT * INTO v_att FROM public.instant_test_attempts WHERE id = p_attempt_id;
  IF NOT FOUND THEN RAISE EXCEPTION 'not_found'; END IF;

  SELECT * INTO v_t FROM public.instant_tests WHERE id = v_att.test_id;
  IF NOT (is_course_faculty(v_t.course_id) OR is_super_admin()) THEN
    RAISE EXCEPTION 'forbidden';
  END IF;

  IF v_att.cheating_marked THEN
    RAISE EXCEPTION 'cheating_terminated';
  END IF;

  IF v_att.reset_count >= 2 THEN
    RAISE EXCEPTION 'max_resets_reached';
  END IF;

  v_next_reset := v_att.reset_count + 1;

  UPDATE public.instant_test_attempts
  SET reset_count = v_next_reset,
      submitted_at = NULL,
      auto_submitted_breach = false,
      active_hold_rule = NULL,
      warning_count = 0,
      ended_reason = NULL
  WHERE id = p_attempt_id;

  INSERT INTO public.proctor_events (
    institution_id, instant_attempt_id, assessment_type,
    event_type, severity, rule_id, level, detail, detail_json, reviewed_by, reviewed_at
  ) VALUES (
    v_att.institution_id, p_attempt_id, 'instant',
    'tab_switch', 1, 'FACULTY-RESET', 'S0',
    'Faculty reset attempt (' || v_next_reset || '/2): ' || coalesce(nullif(trim(p_reason), ''), 'Allowed to resume'),
    jsonb_build_object('reset_count', v_next_reset, 'reason', trim(coalesce(p_reason, ''))),
    me(), now()
  );

  PERFORM public.notify(
    v_att.student_id,
    'instant_reset',
    'Test reset: ' || v_t.topic,
    'Faculty reset your attempt (' || v_next_reset || ' of 2 used). You may resume the test.',
    '/app/student/instant-test/' || p_attempt_id,
    v_att.institution_id
  );

  PERFORM public.audit(
    'faculty_reset_instant_attempt',
    'instant_test_attempt',
    p_attempt_id::text,
    jsonb_build_object('reset_count', v_next_reset, 'reason', trim(coalesce(p_reason, ''))),
    v_att.institution_id
  );

  RETURN v_next_reset;
END;
$$;

-- Faculty can mark cheating and immediately terminate the student's instant test
CREATE OR REPLACE FUNCTION faculty_mark_cheating_and_terminate(
  p_attempt_id uuid,
  p_reason text
)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_att public.instant_test_attempts%ROWTYPE;
  v_t public.instant_tests%ROWTYPE;
  v_clean text := trim(coalesce(p_reason, ''));
BEGIN
  IF v_clean = '' THEN
    RAISE EXCEPTION 'remark_required';
  END IF;

  SELECT * INTO v_att FROM public.instant_test_attempts WHERE id = p_attempt_id;
  IF NOT FOUND THEN RAISE EXCEPTION 'not_found'; END IF;

  SELECT * INTO v_t FROM public.instant_tests WHERE id = v_att.test_id;
  IF NOT (is_course_faculty(v_t.course_id) OR is_super_admin()) THEN
    RAISE EXCEPTION 'forbidden';
  END IF;

  UPDATE public.instant_test_attempts
  SET cheating_marked = true,
      flagged = true,
      review_decision = 'misconduct_suspected',
      review_note = v_clean,
      submitted_at = coalesce(submitted_at, now()),
      ended_reason = 'Terminated for cheating: ' || v_clean
  WHERE id = p_attempt_id;

  INSERT INTO public.proctor_events (
    institution_id, instant_attempt_id, assessment_type,
    event_type, severity, rule_id, level, detail, detail_json, reviewed_by, reviewed_at, review_outcome, review_reason
  ) VALUES (
    v_att.institution_id, p_attempt_id, 'instant',
    'tab_switch', 3, 'FACULTY-CHEATING', 'S3',
    'Terminated for cheating: ' || v_clean,
    jsonb_build_object('reason', v_clean),
    me(), now(), 'confirmed', v_clean
  );

  PERFORM public.notify(
    v_att.student_id,
    'instant_terminated',
    'Test terminated: ' || v_t.topic,
    'Your test was terminated for misconduct: ' || v_clean,
    '/app/student',
    v_att.institution_id
  );

  PERFORM public.audit(
    'faculty_mark_cheating_and_terminate',
    'instant_test_attempt',
    p_attempt_id::text,
    jsonb_build_object('reason', v_clean),
    v_att.institution_id
  );
END;
$$;

GRANT EXECUTE ON FUNCTION faculty_reset_instant_attempt(uuid, text) TO authenticated;
GRANT EXECUTE ON FUNCTION faculty_mark_cheating_and_terminate(uuid, text) TO authenticated;
