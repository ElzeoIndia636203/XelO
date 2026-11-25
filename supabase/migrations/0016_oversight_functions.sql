-- =============================================================
-- 0016 Oversight functions
-- course_stats, at_risk_students, live_lab_stats,
-- set_min_attendance, add_holiday, remove_holiday, dept_stats
-- =============================================================

-- ── course_stats ─────────────────────────────────────────────
-- Returns aggregated stats for the given course IDs.
-- Logs a bulk read in audit_log.

CREATE OR REPLACE FUNCTION course_stats(p_course_ids uuid[])
RETURNS TABLE (
  course_id          uuid,
  students           int,
  sessions_total     int,
  sessions_conducted int,
  attendance_pct     numeric,
  completion_pct     numeric,
  at_risk            int,
  live_now           boolean
)
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public
AS $$
DECLARE
  v_min int;
  v_inst uuid := my_institution();
BEGIN
  IF my_role() NOT IN ('hod', 'dean', 'coe', 'vc', 'faculty', 'super_admin') THEN
    RAISE EXCEPTION 'forbidden';
  END IF;

  SELECT coalesce(min_attendance_pct, 75)
    INTO v_min
    FROM institutions
   WHERE id = v_inst;

  IF p_course_ids IS NOT NULL AND cardinality(p_course_ids) > 0 THEN
    PERFORM public.audit(
      'bulk_read_course_stats',
      'course',
      null,
      jsonb_build_object('course_ids', p_course_ids, 'count', cardinality(p_course_ids)),
      v_inst
    );
  END IF;

  RETURN QUERY
  WITH
  enr AS (
    SELECT e.course_id, count(*)::int AS cnt
      FROM enrollments e
     WHERE e.course_id = ANY(p_course_ids)
     GROUP BY e.course_id
  ),
  sess AS (
    SELECT s.course_id,
           count(*) FILTER (WHERE s.status IN ('draft', 'active', 'conducted'))::int AS total,
           count(*) FILTER (WHERE s.status = 'conducted')::int AS conducted
      FROM sessions s
     WHERE s.course_id = ANY(p_course_ids)
     GROUP BY s.course_id
  ),
  att AS (
    SELECT sr.session_id,
           s.course_id,
           count(*) FILTER (WHERE a.state IN ('present', 'late')) AS present_cnt,
           count(*) AS total_cnt
      FROM attendance a
      JOIN session_runs sr ON sr.id = a.session_run_id
      JOIN sessions s ON s.id = sr.session_id
     WHERE s.course_id = ANY(p_course_ids)
       AND s.status = 'conducted'
     GROUP BY sr.session_id, s.course_id
  ),
  avg_att AS (
    SELECT a.course_id,
           CASE WHEN sum(a.total_cnt) > 0
                THEN 100.0 * sum(a.present_cnt) / sum(a.total_cnt)
                ELSE 0 END AS pct
      FROM att a
     GROUP BY a.course_id
  ),
  student_passed_sessions AS (
    SELECT sub.course_id, sub.student_id, sub.session_id
      FROM submissions sub
      JOIN sessions s ON s.id = sub.session_id
     WHERE sub.course_id = ANY(p_course_ids)
       AND s.status = 'conducted'
       AND sub.context = 'lab'
       AND sub.mode = 'submit'
       AND sub.hidden_total > 0
       AND sub.hidden_passed = sub.hidden_total
     GROUP BY sub.course_id, sub.student_id, sub.session_id
    HAVING count(DISTINCT sub.question_id) >= 2
  ),
  comp AS (
    SELECT s.course_id,
           count(DISTINCT CASE WHEN sps.student_id IS NOT NULL THEN (sps.student_id, s.id) END) AS passed_pairs,
           count(DISTINCT (e.student_id, s.id)) AS total_pairs
      FROM enrollments e
      JOIN sessions s ON s.course_id = e.course_id AND s.status = 'conducted'
      LEFT JOIN student_passed_sessions sps
        ON sps.course_id = s.course_id
       AND sps.session_id = s.id
       AND sps.student_id = e.student_id
     WHERE e.course_id = ANY(p_course_ids)
     GROUP BY s.course_id
  ),
  per_student_att AS (
    SELECT e.course_id, e.student_id,
           CASE WHEN count(a.id) > 0
                THEN 100.0 * count(*) FILTER (WHERE a.state IN ('present', 'late')) / count(a.id)
                ELSE 100.0 END AS pct
      FROM enrollments e
      JOIN sessions s ON s.course_id = e.course_id AND s.status = 'conducted'
      LEFT JOIN session_runs sr ON sr.session_id = s.id AND sr.batch_id = e.batch_id
      LEFT JOIN attendance a ON a.session_run_id = sr.id AND a.student_id = e.student_id
     WHERE e.course_id = ANY(p_course_ids)
     GROUP BY e.course_id, e.student_id
  ),
  per_student_comp AS (
    SELECT e.course_id, e.student_id,
           count(DISTINCT sps.session_id) AS passed_cnt
      FROM enrollments e
      LEFT JOIN student_passed_sessions sps
        ON sps.course_id = e.course_id AND sps.student_id = e.student_id
     WHERE e.course_id = ANY(p_course_ids)
     GROUP BY e.course_id, e.student_id
  ),
  risk AS (
    SELECT e.course_id,
           count(DISTINCT e.student_id)::int AS cnt
      FROM enrollments e
      JOIN sess ON sess.course_id = e.course_id AND sess.conducted >= 2
      LEFT JOIN per_student_att psa ON psa.course_id = e.course_id AND psa.student_id = e.student_id
      LEFT JOIN per_student_comp psc ON psc.course_id = e.course_id AND psc.student_id = e.student_id
     WHERE e.course_id = ANY(p_course_ids)
       AND (
         coalesce(psa.pct, 100.0) < v_min
         OR coalesce(psc.passed_cnt, 0) < (sess.conducted * 0.5)
       )
     GROUP BY e.course_id
  ),
  live AS (
    SELECT s.course_id,
           bool_or(s.status = 'active') AS is_live
      FROM sessions s
     WHERE s.course_id = ANY(p_course_ids)
     GROUP BY s.course_id
  )
  SELECT
    c.id                                       AS course_id,
    coalesce(enr.cnt, 0)::int                  AS students,
    coalesce(sess.total, 0)::int               AS sessions_total,
    coalesce(sess.conducted, 0)::int           AS sessions_conducted,
    round(coalesce(avg_att.pct, 0), 1)         AS attendance_pct,
    CASE WHEN coalesce(comp.total_pairs, 0) > 0
         THEN round(100.0 * comp.passed_pairs / comp.total_pairs, 1)
         ELSE 0 END                            AS completion_pct,
    coalesce(risk.cnt, 0)::int                 AS at_risk,
    coalesce(live.is_live, false)              AS live_now
  FROM unnest(p_course_ids) AS c(id)
  LEFT JOIN enr     ON enr.course_id = c.id
  LEFT JOIN sess    ON sess.course_id = c.id
  LEFT JOIN avg_att ON avg_att.course_id = c.id
  LEFT JOIN comp    ON comp.course_id = c.id
  LEFT JOIN risk    ON risk.course_id = c.id
  LEFT JOIN live    ON live.course_id = c.id;
END;
$$;

-- ── at_risk_students ──────────────────────────────────────────

CREATE OR REPLACE FUNCTION at_risk_students(p_course_ids uuid[])
RETURNS TABLE (
  student_id     uuid,
  roll           text,
  name           text,
  course         text,
  code           text,
  reason         text,
  attendance_pct numeric
)
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public
AS $$
DECLARE
  v_min int;
  v_inst uuid := my_institution();
BEGIN
  IF my_role() NOT IN ('hod', 'dean', 'coe', 'vc', 'faculty', 'super_admin') THEN
    RAISE EXCEPTION 'forbidden';
  END IF;

  SELECT coalesce(min_attendance_pct, 75)
    INTO v_min
    FROM institutions
   WHERE id = v_inst;

  IF p_course_ids IS NOT NULL AND cardinality(p_course_ids) > 0 THEN
    PERFORM public.audit(
      'bulk_read_at_risk_students',
      'course',
      null,
      jsonb_build_object('course_ids', p_course_ids),
      v_inst
    );
  END IF;

  RETURN QUERY
  WITH conducted AS (
    SELECT s.course_id, count(*)::int AS n
      FROM sessions s
     WHERE s.course_id = ANY(p_course_ids) AND s.status = 'conducted'
     GROUP BY s.course_id
  ),
  student_att AS (
    SELECT e.student_id, e.course_id,
           CASE WHEN count(a.id) > 0
                THEN round(100.0 * count(*) FILTER (WHERE a.state IN ('present', 'late')) / count(a.id), 1)
                ELSE 100.0 END AS pct
      FROM enrollments e
      JOIN sessions s ON s.course_id = e.course_id AND s.status = 'conducted'
      LEFT JOIN session_runs sr ON sr.session_id = s.id AND sr.batch_id = e.batch_id
      LEFT JOIN attendance a ON a.session_run_id = sr.id AND a.student_id = e.student_id
     WHERE e.course_id = ANY(p_course_ids)
     GROUP BY e.student_id, e.course_id
  ),
  student_comp AS (
    SELECT sub.student_id, sub.course_id,
           count(DISTINCT sub.session_id)::int AS passed
      FROM submissions sub
      JOIN sessions s ON s.id = sub.session_id AND s.status = 'conducted'
     WHERE sub.course_id = ANY(p_course_ids)
       AND sub.context = 'lab'
       AND sub.mode = 'submit'
       AND sub.hidden_total > 0
       AND sub.hidden_passed = sub.hidden_total
     GROUP BY sub.student_id, sub.course_id, sub.session_id
    HAVING count(DISTINCT sub.question_id) >= 2
  ),
  student_comp_agg AS (
    SELECT sc.student_id, sc.course_id, count(*)::int AS passed
      FROM student_comp sc
     GROUP BY sc.student_id, sc.course_id
  )
  SELECT
    p.id                   AS student_id,
    coalesce(p.roll_no, '') AS roll,
    p.full_name            AS name,
    c.title                AS course,
    c.code                 AS code,
    CASE
      WHEN coalesce(sa.pct, 100.0) < v_min THEN 'Low attendance'
      ELSE 'Low completion'
    END                    AS reason,
    coalesce(sa.pct, 100.0) AS attendance_pct
  FROM enrollments e
  JOIN profiles p   ON p.id = e.student_id
  JOIN courses c    ON c.id = e.course_id
  JOIN conducted cd ON cd.course_id = e.course_id
  LEFT JOIN student_att sa       ON sa.student_id = e.student_id AND sa.course_id = e.course_id
  LEFT JOIN student_comp_agg sca ON sca.student_id = e.student_id AND sca.course_id = e.course_id
  WHERE e.course_id = ANY(p_course_ids)
    AND cd.n >= 2
    AND (
      coalesce(sa.pct, 100.0) < v_min
      OR coalesce(sca.passed, 0) < (cd.n * 0.5)
    )
  ORDER BY c.code, p.roll_no;
END;
$$;

-- ── live_lab_stats ────────────────────────────────────────────

CREATE OR REPLACE FUNCTION live_lab_stats(p_course_ids uuid[])
RETURNS TABLE (
  course_code  text,
  batch_name   text,
  room         text,
  slot         text,
  session_n    int,
  topic        text,
  started_at   timestamptz,
  ended_at     timestamptz,
  enrolled     int,
  present      int,
  pre_done     int,
  passed       int,
  struggling   int
)
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public
AS $$
BEGIN
  RETURN QUERY
  SELECT
    c.code,
    b.name,
    b.room,
    b.slot,
    s.n::int,
    s.topic,
    sr.started_at,
    sr.ended_at,
    (SELECT count(*)::int FROM enrollments e WHERE e.course_id = c.id AND e.batch_id = b.id) AS enrolled,
    (SELECT count(*)::int FROM attendance a WHERE a.session_run_id = sr.id AND a.state IN ('present', 'late')) AS present,
    (SELECT count(DISTINCT ta.student_id)::int
       FROM test_attempts ta
       JOIN enrollments e ON e.student_id = ta.student_id AND e.course_id = c.id AND e.batch_id = b.id
      WHERE ta.session_id = s.id AND ta.bank = 'pre' AND ta.submitted_at IS NOT NULL) AS pre_done,
    (SELECT count(*)::int FROM (
       SELECT sub.student_id
         FROM submissions sub
         JOIN enrollments e ON e.student_id = sub.student_id AND e.course_id = c.id AND e.batch_id = b.id
        WHERE sub.session_id = s.id AND sub.context = 'lab' AND sub.mode = 'submit'
          AND sub.hidden_total > 0 AND sub.hidden_passed = sub.hidden_total
        GROUP BY sub.student_id
       HAVING count(DISTINCT sub.question_id) >= 2
     ) p_cnt) AS passed,
    (SELECT count(DISTINCT a2.student_id)::int
       FROM attendance a2
      WHERE a2.session_run_id = sr.id AND a2.state IN ('present', 'late')
        AND NOT EXISTS (
          SELECT 1 FROM submissions sub2
           WHERE sub2.session_id = s.id
             AND sub2.student_id = a2.student_id
             AND sub2.context = 'lab'
             AND sub2.mode = 'submit'
        )) AS struggling
  FROM session_runs sr
  JOIN sessions s ON s.id = sr.session_id
  JOIN courses c  ON c.id = s.course_id
  JOIN batches b  ON b.id = sr.batch_id
  WHERE s.course_id = ANY(p_course_ids)
    AND s.status = 'active'
  ORDER BY sr.started_at DESC NULLS LAST;
END;
$$;

-- ── set_min_attendance ────────────────────────────────────────

CREATE OR REPLACE FUNCTION set_min_attendance(p_pct integer)
RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public
AS $$
DECLARE
  v_inst uuid := my_institution();
BEGIN
  IF my_role() NOT IN ('coe', 'vc') THEN
    RAISE EXCEPTION 'forbidden';
  END IF;
  IF p_pct < 0 OR p_pct > 100 THEN
    RAISE EXCEPTION 'invalid_pct';
  END IF;
  UPDATE institutions SET min_attendance_pct = p_pct
   WHERE id = v_inst;
  PERFORM public.audit(
    'set_min_attendance',
    'institution',
    v_inst::text,
    jsonb_build_object('pct', p_pct),
    v_inst
  );
END;
$$;

-- ── add_holiday / remove_holiday ──────────────────────────────

CREATE OR REPLACE FUNCTION add_holiday(p_day date, p_label text)
RETURNS uuid
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public
AS $$
DECLARE
  v_id uuid;
  v_inst uuid := my_institution();
BEGIN
  IF my_role() NOT IN ('coe', 'vc') THEN
    RAISE EXCEPTION 'forbidden';
  END IF;
  INSERT INTO holidays (institution_id, day, label)
  VALUES (v_inst, p_day, trim(p_label))
  RETURNING id INTO v_id;
  PERFORM public.audit(
    'add_holiday',
    'holiday',
    v_id::text,
    jsonb_build_object('day', p_day, 'label', trim(p_label)),
    v_inst
  );
  RETURN v_id;
END;
$$;

CREATE OR REPLACE FUNCTION remove_holiday(p_id uuid)
RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public
AS $$
DECLARE
  v_inst uuid := my_institution();
BEGIN
  IF my_role() NOT IN ('coe', 'vc') THEN
    RAISE EXCEPTION 'forbidden';
  END IF;
  DELETE FROM holidays
   WHERE id = p_id AND institution_id = v_inst;
  PERFORM public.audit(
    'remove_holiday',
    'holiday',
    p_id::text,
    '{}'::jsonb,
    v_inst
  );
END;
$$;

-- ── dept_stats ────────────────────────────────────────────────

CREATE OR REPLACE FUNCTION dept_stats()
RETURNS TABLE (
  department_id   uuid,
  department_name text,
  school          text,
  lab_courses     int,
  students        int,
  labs_live_now   int,
  attendance_pct  numeric,
  completion_pct  numeric,
  co_attained     int,
  co_total        int,
  at_risk         int
)
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public
AS $$
DECLARE
  v_role text := my_role();
  v_inst uuid := my_institution();
  v_school uuid;
BEGIN
  IF v_role NOT IN ('coe', 'vc', 'dean', 'hod') THEN
    RAISE EXCEPTION 'forbidden';
  END IF;

  IF v_role = 'dean' THEN
    SELECT school_id INTO v_school FROM profiles WHERE id = auth.uid();
  END IF;

  PERFORM public.audit(
    'bulk_read_dept_stats',
    'department',
    null,
    jsonb_build_object('role', v_role),
    v_inst
  );

  RETURN QUERY
  WITH dept_courses AS (
    SELECT d.id AS dept_id, d.name AS dept_name, s.name AS school_name,
           c.id AS course_id
      FROM departments d
      JOIN schools s ON s.id = d.school_id
      JOIN courses c ON c.department_id = d.id
     WHERE d.institution_id = v_inst
       AND (v_school IS NULL OR d.school_id = v_school)
  ),
  cs AS (
    SELECT * FROM course_stats(ARRAY(SELECT course_id FROM dept_courses))
  ),
  snap AS (
    SELECT cs2.course_id,
           (SELECT count(*)::int FROM jsonb_each_text(cs2.co_overall) kv WHERE (kv.value::numeric) >= 60) AS co_att,
           (SELECT count(*)::int FROM jsonb_object_keys(cs2.co_overall)) AS co_tot
      FROM course_snapshots cs2
     WHERE cs2.course_id IN (SELECT course_id FROM dept_courses)
  )
  SELECT
    dc.dept_id,
    dc.dept_name,
    dc.school_name,
    count(DISTINCT dc.course_id)::int        AS lab_courses,
    coalesce(sum(cs.students), 0)::int       AS students,
    count(*) FILTER (WHERE cs.live_now)::int AS labs_live_now,
    round(coalesce(avg(cs.attendance_pct), 0), 1) AS attendance_pct,
    round(coalesce(avg(cs.completion_pct), 0), 1) AS completion_pct,
    coalesce(sum(snap.co_att), 0)::int       AS co_attained,
    coalesce(sum(snap.co_tot), 0)::int       AS co_total,
    coalesce(sum(cs.at_risk), 0)::int        AS at_risk
  FROM dept_courses dc
  JOIN cs ON cs.course_id = dc.course_id
  LEFT JOIN snap ON snap.course_id = dc.course_id
  GROUP BY dc.dept_id, dc.dept_name, dc.school_name
  ORDER BY dc.dept_name;
END;
$$;

GRANT EXECUTE ON FUNCTION course_stats(uuid[])        TO authenticated;
GRANT EXECUTE ON FUNCTION at_risk_students(uuid[])    TO authenticated;
GRANT EXECUTE ON FUNCTION live_lab_stats(uuid[])      TO authenticated;
GRANT EXECUTE ON FUNCTION set_min_attendance(integer) TO authenticated;
GRANT EXECUTE ON FUNCTION add_holiday(date, text)     TO authenticated;
GRANT EXECUTE ON FUNCTION remove_holiday(uuid)        TO authenticated;
GRANT EXECUTE ON FUNCTION dept_stats()                TO authenticated;
