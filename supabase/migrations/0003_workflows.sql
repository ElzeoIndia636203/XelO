-- Phase 1: Workflows, sign-up gate, admin RPCs, and AI credit accounting

CREATE OR REPLACE FUNCTION audit(
  p_action text,
  p_object_type text,
  p_object_id text DEFAULT NULL,
  p_detail jsonb DEFAULT '{}'::jsonb,
  p_institution_id uuid DEFAULT NULL,
  p_actor_id uuid DEFAULT auth.uid()
)
RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_id uuid;
  v_inst uuid;
BEGIN
  v_inst := COALESCE(
    p_institution_id,
    (SELECT institution_id FROM public.profiles WHERE id = p_actor_id)
  );

  INSERT INTO public.audit_log (institution_id, actor_id, action, object_type, object_id, detail)
  VALUES (v_inst, p_actor_id, p_action, p_object_type, p_object_id, COALESCE(p_detail, '{}'::jsonb))
  RETURNING id INTO v_id;

  RETURN v_id;
END;
$$;

REVOKE ALL ON FUNCTION public.audit(text, text, text, jsonb, uuid, uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.audit(text, text, text, jsonb, uuid, uuid) TO service_role;

CREATE OR REPLACE FUNCTION preflight_sign_in(p_email text)
RETURNS text
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_email text := lower(trim(coalesce(p_email, '')));
  v_domain text;
  v_prof public.profiles%ROWTYPE;
  v_inv public.invites%ROWTYPE;
  v_inst_domain text;
BEGIN
  IF v_email = '' OR position('@' IN v_email) = 0 THEN
    RETURN 'domain_mismatch';
  END IF;
  v_domain := split_part(v_email, '@', 2);

  SELECT * INTO v_prof FROM public.profiles WHERE lower(email) = v_email LIMIT 1;
  IF FOUND THEN
    IF NOT v_prof.active THEN
      RETURN 'deactivated';
    END IF;
    IF v_prof.role = 'super_admin' THEN
      RETURN 'ok';
    END IF;
    SELECT lower(email_domain) INTO v_inst_domain FROM public.institutions WHERE id = v_prof.institution_id;
    IF v_inst_domain IS NOT NULL AND v_domain = v_inst_domain THEN
      RETURN 'ok';
    END IF;
    RETURN 'domain_mismatch';
  END IF;

  SELECT * INTO v_inv FROM public.invites WHERE lower(email) = v_email AND accepted_at IS NULL LIMIT 1;
  IF FOUND THEN
    IF v_inv.role = 'super_admin' THEN
      RETURN 'ok';
    END IF;
    SELECT lower(email_domain) INTO v_inst_domain FROM public.institutions WHERE id = v_inv.institution_id;
    IF v_inst_domain IS NOT NULL AND v_domain = v_inst_domain THEN
      RETURN 'ok';
    END IF;
    RETURN 'domain_mismatch';
  END IF;

  IF EXISTS (SELECT 1 FROM public.institutions WHERE lower(email_domain) = v_domain) THEN
    RETURN 'not_onboarded';
  END IF;

  RETURN 'domain_mismatch';
END;
$$;

GRANT EXECUTE ON FUNCTION public.preflight_sign_in(text) TO anon, authenticated;

CREATE OR REPLACE FUNCTION handle_new_user()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_email text := lower(trim(coalesce(NEW.email, '')));
  v_domain text := split_part(v_email, '@', 2);
  v_inv public.invites%ROWTYPE;
  v_inst_domain text;
BEGIN
  SELECT * INTO v_inv
  FROM public.invites
  WHERE lower(email) = v_email AND accepted_at IS NULL
  LIMIT 1;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'not_invited';
  END IF;

  IF v_inv.institution_id IS NOT NULL THEN
    SELECT lower(email_domain) INTO v_inst_domain
    FROM public.institutions
    WHERE id = v_inv.institution_id;

    IF v_inst_domain IS NULL OR v_domain <> v_inst_domain THEN
      RAISE EXCEPTION 'domain_mismatch';
    END IF;
  END IF;

  INSERT INTO public.profiles (
    id, institution_id, email, full_name, role, school_id, department_id, roll_no, active
  )
  VALUES (
    NEW.id, v_inv.institution_id, v_email, v_inv.full_name, v_inv.role,
    v_inv.school_id, v_inv.department_id, v_inv.roll_no, true
  );

  UPDATE public.invites
  SET accepted_at = now()
  WHERE id = v_inv.id;

  PERFORM public.audit(
    'signup',
    'profile',
    NEW.id::text,
    jsonb_build_object('email', v_email, 'role', v_inv.role::text),
    v_inv.institution_id,
    NEW.id
  );

  RETURN NEW;
END;
$$;

CREATE TRIGGER on_auth_user_created
  AFTER INSERT ON auth.users
  FOR EACH ROW
  EXECUTE FUNCTION public.handle_new_user();

CREATE OR REPLACE FUNCTION admin_create_institution(p_name text, p_email_domain text)
RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_id uuid;
  v_name text := trim(coalesce(p_name, ''));
  v_domain text := lower(trim(coalesce(p_email_domain, '')));
BEGIN
  IF NOT is_super_admin() THEN
    RAISE EXCEPTION 'forbidden';
  END IF;
  IF v_name = '' OR v_domain = '' THEN
    RAISE EXCEPTION 'invalid_input';
  END IF;

  INSERT INTO public.institutions (name, email_domain)
  VALUES (v_name, v_domain)
  RETURNING id INTO v_id;

  PERFORM public.audit(
    'create_institution',
    'institution',
    v_id::text,
    jsonb_build_object('name', v_name, 'email_domain', v_domain),
    v_id
  );

  RETURN v_id;
END;
$$;

CREATE OR REPLACE FUNCTION admin_create_school(p_institution_id uuid, p_name text)
RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_id uuid;
  v_name text := trim(coalesce(p_name, ''));
BEGIN
  IF NOT is_super_admin() THEN
    RAISE EXCEPTION 'forbidden';
  END IF;
  IF v_name = '' THEN
    RAISE EXCEPTION 'invalid_input';
  END IF;

  INSERT INTO public.schools (institution_id, name)
  VALUES (p_institution_id, v_name)
  RETURNING id INTO v_id;

  PERFORM public.audit(
    'create_school',
    'school',
    v_id::text,
    jsonb_build_object('name', v_name),
    p_institution_id
  );

  RETURN v_id;
END;
$$;

CREATE OR REPLACE FUNCTION admin_create_department(
  p_institution_id uuid,
  p_school_id uuid,
  p_code text,
  p_name text
)
RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_id uuid;
  v_code text := upper(trim(coalesce(p_code, '')));
  v_name text := trim(coalesce(p_name, ''));
BEGIN
  IF NOT is_super_admin() THEN
    RAISE EXCEPTION 'forbidden';
  END IF;
  IF v_code = '' OR v_name = '' THEN
    RAISE EXCEPTION 'invalid_input';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM public.schools s WHERE s.id = p_school_id AND s.institution_id = p_institution_id
  ) THEN
    RAISE EXCEPTION 'invalid_scope';
  END IF;

  INSERT INTO public.departments (institution_id, school_id, code, name)
  VALUES (p_institution_id, p_school_id, v_code, v_name)
  RETURNING id INTO v_id;

  PERFORM public.audit(
    'create_department',
    'department',
    v_id::text,
    jsonb_build_object('code', v_code, 'name', v_name),
    p_institution_id
  );

  RETURN v_id;
END;
$$;

CREATE OR REPLACE FUNCTION admin_invite(
  p_email text,
  p_role user_role,
  p_full_name text,
  p_institution_id uuid,
  p_school_id uuid DEFAULT NULL,
  p_department_id uuid DEFAULT NULL
)
RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_email text := lower(trim(coalesce(p_email, '')));
  v_name text := trim(coalesce(p_full_name, ''));
  v_domain text := split_part(v_email, '@', 2);
  v_inst_domain text;
  v_id uuid;
BEGIN
  IF NOT is_super_admin() THEN
    RAISE EXCEPTION 'forbidden';
  END IF;
  IF v_email = '' OR v_name = '' OR position('@' IN v_email) = 0 THEN
    RAISE EXCEPTION 'invalid_input';
  END IF;

  IF p_role <> 'super_admin' THEN
    SELECT lower(email_domain) INTO v_inst_domain
    FROM public.institutions
    WHERE id = p_institution_id;

    IF v_inst_domain IS NULL THEN
      RAISE EXCEPTION 'institution_not_found';
    END IF;
    IF v_domain <> v_inst_domain THEN
      RAISE EXCEPTION 'domain_mismatch';
    END IF;
  END IF;

  IF EXISTS (SELECT 1 FROM public.profiles WHERE lower(email) = v_email)
     OR EXISTS (SELECT 1 FROM public.invites WHERE lower(email) = v_email) THEN
    RAISE EXCEPTION 'already_exists';
  END IF;

  INSERT INTO public.invites (
    email, institution_id, role, full_name, school_id, department_id, created_by
  )
  VALUES (
    v_email, p_institution_id, p_role, v_name, p_school_id, p_department_id, auth.uid()
  )
  RETURNING id INTO v_id;

  PERFORM public.audit(
    'invite_user',
    'invite',
    v_id::text,
    jsonb_build_object('email', v_email, 'role', p_role::text, 'full_name', v_name),
    p_institution_id
  );

  RETURN v_id;
END;
$$;

CREATE OR REPLACE FUNCTION admin_set_active(p_user_id uuid, p_active boolean)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_prof public.profiles%ROWTYPE;
BEGIN
  IF NOT is_super_admin() THEN
    RAISE EXCEPTION 'forbidden';
  END IF;
  IF p_user_id = auth.uid() AND NOT p_active THEN
    RAISE EXCEPTION 'cannot_deactivate_self';
  END IF;

  SELECT * INTO v_prof FROM public.profiles WHERE id = p_user_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'not_found';
  END IF;

  UPDATE public.profiles SET active = p_active WHERE id = p_user_id;

  PERFORM public.audit(
    CASE WHEN p_active THEN 'enable_user' ELSE 'disable_user' END,
    'profile',
    p_user_id::text,
    jsonb_build_object('email', v_prof.email, 'active', p_active),
    v_prof.institution_id
  );
END;
$$;

CREATE OR REPLACE FUNCTION admin_update_plan_caps(
  p_tier plan_tier,
  p_total_cap integer,
  p_daily_cap integer
)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  IF NOT is_super_admin() THEN
    RAISE EXCEPTION 'forbidden';
  END IF;
  IF p_total_cap < 0 OR p_daily_cap < 1 THEN
    RAISE EXCEPTION 'invalid_input';
  END IF;

  UPDATE public.plans
  SET total_cap = p_total_cap, daily_cap = p_daily_cap
  WHERE tier = p_tier;

  PERFORM public.audit(
    'update_plan_caps',
    'plan',
    p_tier::text,
    jsonb_build_object('total_cap', p_total_cap, 'daily_cap', p_daily_cap),
    NULL
  );
END;
$$;

CREATE OR REPLACE FUNCTION admin_create_subscription_request(
  p_institution_id uuid,
  p_plan plan_tier,
  p_start_date date,
  p_months integer,
  p_scope_label text DEFAULT ''
)
RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_id uuid;
BEGIN
  IF NOT is_super_admin() THEN
    RAISE EXCEPTION 'forbidden';
  END IF;
  IF p_months NOT IN (3, 6, 12) THEN
    RAISE EXCEPTION 'invalid_input';
  END IF;

  INSERT INTO public.subscription_requests (
    institution_id, requested_by, scope_label, plan, start_date, months, status
  )
  VALUES (
    p_institution_id, auth.uid(), trim(coalesce(p_scope_label, '')), p_plan, p_start_date, p_months, 'sent'
  )
  RETURNING id INTO v_id;

  PERFORM public.audit(
    'create_subscription_request',
    'subscription_request',
    v_id::text,
    jsonb_build_object('plan', p_plan::text, 'start_date', p_start_date, 'months', p_months),
    p_institution_id
  );

  RETURN v_id;
END;
$$;

CREATE OR REPLACE FUNCTION decide_subscription(
  p_request_id uuid,
  p_approve boolean,
  p_plan plan_tier DEFAULT NULL,
  p_start_date date DEFAULT NULL,
  p_months integer DEFAULT NULL
)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_req public.subscription_requests%ROWTYPE;
  v_plan plan_tier;
  v_start date;
  v_months integer;
  v_end date;
BEGIN
  IF NOT is_super_admin() THEN
    RAISE EXCEPTION 'forbidden';
  END IF;

  SELECT * INTO v_req FROM public.subscription_requests WHERE id = p_request_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'not_found';
  END IF;
  IF v_req.status <> 'sent' THEN
    RAISE EXCEPTION 'not_pending';
  END IF;

  v_plan := COALESCE(p_plan, v_req.plan);
  v_start := COALESCE(p_start_date, v_req.start_date);
  v_months := COALESCE(p_months, v_req.months);
  IF v_months NOT IN (3, 6, 12) THEN
    RAISE EXCEPTION 'invalid_input';
  END IF;

  UPDATE public.subscription_requests
  SET plan = v_plan,
      start_date = v_start,
      months = v_months,
      status = CASE WHEN p_approve THEN 'approved'::subscription_status ELSE 'rejected'::subscription_status END,
      decided_by = auth.uid(),
      decided_at = now()
  WHERE id = p_request_id;

  IF p_approve THEN
    v_end := (v_start + make_interval(months => v_months) - interval '1 day')::date;
    UPDATE public.institutions
    SET plan = v_plan,
        plan_start = v_start,
        plan_end = v_end
    WHERE id = v_req.institution_id;
  END IF;

  PERFORM public.audit(
    CASE WHEN p_approve THEN 'approve_subscription' ELSE 'reject_subscription' END,
    'subscription_request',
    p_request_id::text,
    jsonb_build_object('plan', v_plan::text, 'start_date', v_start, 'months', v_months, 'plan_end', v_end),
    v_req.institution_id
  );
END;
$$;

CREATE OR REPLACE FUNCTION admin_set_faculty_plan(p_user_id uuid, p_plan plan_tier)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_prof public.profiles%ROWTYPE;
BEGIN
  IF NOT is_super_admin() THEN
    RAISE EXCEPTION 'forbidden';
  END IF;

  SELECT * INTO v_prof FROM public.profiles WHERE id = p_user_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'not_found';
  END IF;

  UPDATE public.profiles SET plan_override = p_plan WHERE id = p_user_id;

  PERFORM public.audit(
    'set_faculty_plan',
    'profile',
    p_user_id::text,
    jsonb_build_object('email', v_prof.email, 'plan', p_plan::text),
    v_prof.institution_id
  );
END;
$$;

CREATE OR REPLACE FUNCTION ai_usage(p_user_id uuid DEFAULT auth.uid())
RETURNS TABLE (
  tier plan_tier,
  plan_start date,
  plan_end date,
  total_cap integer,
  daily_cap integer,
  total_used integer,
  today_used integer,
  plan_active boolean
)
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_prof public.profiles%ROWTYPE;
  v_inst public.institutions%ROWTYPE;
  v_tier plan_tier;
  v_plan public.plans%ROWTYPE;
  v_today_ist date := (now() AT TIME ZONE 'Asia/Kolkata')::date;
  v_active boolean;
  v_total integer := 0;
  v_today integer := 0;
BEGIN
  IF p_user_id IS NULL THEN
    RAISE EXCEPTION 'forbidden';
  END IF;
  IF p_user_id <> auth.uid() AND NOT is_super_admin() THEN
    RAISE EXCEPTION 'forbidden';
  END IF;

  SELECT * INTO v_prof FROM public.profiles WHERE id = p_user_id;
  IF NOT FOUND OR v_prof.institution_id IS NULL THEN
    RETURN QUERY SELECT NULL::plan_tier, NULL::date, NULL::date, 0, 0, 0, 0, false;
    RETURN;
  END IF;

  SELECT * INTO v_inst FROM public.institutions WHERE id = v_prof.institution_id;
  v_tier := COALESCE(v_prof.plan_override, v_inst.plan);
  v_active := v_tier IS NOT NULL
    AND v_inst.plan_start IS NOT NULL
    AND v_inst.plan_end IS NOT NULL
    AND v_today_ist BETWEEN v_inst.plan_start AND v_inst.plan_end;

  IF v_tier IS NOT NULL THEN
    SELECT * INTO v_plan FROM public.plans WHERE plans.tier = v_tier;
  END IF;

  IF v_inst.plan_start IS NOT NULL AND v_inst.plan_end IS NOT NULL THEN
    SELECT
      count(*) FILTER (WHERE (ar.at AT TIME ZONE 'Asia/Kolkata')::date BETWEEN v_inst.plan_start AND v_inst.plan_end)::integer,
      count(*) FILTER (WHERE (ar.at AT TIME ZONE 'Asia/Kolkata')::date = v_today_ist)::integer
    INTO v_total, v_today
    FROM public.ai_runs ar
    WHERE ar.user_id = p_user_id AND ar.charged = true;
  END IF;

  RETURN QUERY SELECT
    v_tier,
    v_inst.plan_start,
    v_inst.plan_end,
    COALESCE(v_plan.total_cap, 0),
    COALESCE(v_plan.daily_cap, 0),
    v_total,
    v_today,
    v_active;
END;
$$;

CREATE OR REPLACE FUNCTION consume_ai_credit(
  p_feature text,
  p_course_id uuid DEFAULT NULL
)
RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_uid uuid := auth.uid();
  v_prof public.profiles%ROWTYPE;
  v_inst public.institutions%ROWTYPE;
  v_tier plan_tier;
  v_plan public.plans%ROWTYPE;
  v_today_ist date := (now() AT TIME ZONE 'Asia/Kolkata')::date;
  v_total integer;
  v_today integer;
  v_run_id uuid;
BEGIN
  IF v_uid IS NULL THEN
    RAISE EXCEPTION 'forbidden';
  END IF;

  SELECT * INTO v_prof FROM public.profiles WHERE id = v_uid AND active = true FOR UPDATE;
  IF NOT FOUND OR v_prof.role NOT IN ('faculty', 'hod', 'super_admin') THEN
    RAISE EXCEPTION 'forbidden';
  END IF;

  IF v_prof.institution_id IS NULL THEN
    RAISE EXCEPTION 'no_plan';
  END IF;

  SELECT * INTO v_inst FROM public.institutions WHERE id = v_prof.institution_id;
  v_tier := COALESCE(v_prof.plan_override, v_inst.plan);

  IF v_tier IS NULL OR v_inst.plan_start IS NULL OR v_inst.plan_end IS NULL
     OR NOT (v_today_ist BETWEEN v_inst.plan_start AND v_inst.plan_end) THEN
    RAISE EXCEPTION 'no_plan';
  END IF;

  SELECT * INTO v_plan FROM public.plans WHERE tier = v_tier;

  SELECT
    count(*) FILTER (WHERE (ar.at AT TIME ZONE 'Asia/Kolkata')::date BETWEEN v_inst.plan_start AND v_inst.plan_end)::integer,
    count(*) FILTER (WHERE (ar.at AT TIME ZONE 'Asia/Kolkata')::date = v_today_ist)::integer
  INTO v_total, v_today
  FROM public.ai_runs ar
  WHERE ar.user_id = v_uid AND ar.charged = true;

  IF v_total >= v_plan.total_cap THEN
    RAISE EXCEPTION 'total_cap';
  END IF;

  IF v_today >= v_plan.daily_cap THEN
    RAISE EXCEPTION 'daily_cap';
  END IF;

  INSERT INTO public.ai_runs (institution_id, user_id, feature, course_id, status, charged)
  VALUES (v_prof.institution_id, v_uid, p_feature, p_course_id, 'started', true)
  RETURNING id INTO v_run_id;

  RETURN v_run_id;
END;
$$;

CREATE OR REPLACE FUNCTION refund_ai_credit(
  p_run_id uuid,
  p_reason text DEFAULT 'validation_failed'
)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  UPDATE public.ai_runs
  SET charged = false, status = COALESCE(NULLIF(trim(p_reason), ''), 'validation_failed')
  WHERE id = p_run_id;
END;
$$;

REVOKE ALL ON FUNCTION public.refund_ai_credit(uuid, text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.refund_ai_credit(uuid, text) TO service_role;

CREATE OR REPLACE FUNCTION ai_usage_report()
RETURNS TABLE (
  user_id uuid,
  full_name text,
  email text,
  institution_id uuid,
  institution_name text,
  tier plan_tier,
  plan_end date,
  total_cap integer,
  daily_cap integer,
  total_used integer,
  today_used integer,
  plan_active boolean
)
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_today_ist date := (now() AT TIME ZONE 'Asia/Kolkata')::date;
BEGIN
  IF NOT is_super_admin() THEN
    RAISE EXCEPTION 'forbidden';
  END IF;

  RETURN QUERY
  SELECT
    p.id,
    p.full_name,
    p.email,
    i.id,
    i.name,
    COALESCE(p.plan_override, i.plan) AS tier,
    i.plan_end,
    COALESCE(pl.total_cap, 0),
    COALESCE(pl.daily_cap, 0),
    COALESCE((
      SELECT count(*)::integer
      FROM public.ai_runs ar
      WHERE ar.user_id = p.id
        AND ar.charged = true
        AND i.plan_start IS NOT NULL
        AND i.plan_end IS NOT NULL
        AND (ar.at AT TIME ZONE 'Asia/Kolkata')::date BETWEEN i.plan_start AND i.plan_end
    ), 0) AS total_used,
    COALESCE((
      SELECT count(*)::integer
      FROM public.ai_runs ar
      WHERE ar.user_id = p.id
        AND ar.charged = true
        AND (ar.at AT TIME ZONE 'Asia/Kolkata')::date = v_today_ist
    ), 0) AS today_used,
    (
      COALESCE(p.plan_override, i.plan) IS NOT NULL
      AND i.plan_start IS NOT NULL
      AND i.plan_end IS NOT NULL
      AND v_today_ist BETWEEN i.plan_start AND i.plan_end
    ) AS plan_active
  FROM public.profiles p
  JOIN public.institutions i ON i.id = p.institution_id
  LEFT JOIN public.plans pl ON pl.tier = COALESCE(p.plan_override, i.plan)
  WHERE p.role IN ('faculty', 'hod') AND p.active = true
  ORDER BY p.full_name;
END;
$$;

CREATE OR REPLACE FUNCTION admin_audit_feed(p_limit integer DEFAULT 200)
RETURNS TABLE (
  id uuid,
  at timestamptz,
  action text,
  object_type text,
  object_id text,
  actor_name text,
  actor_role user_role,
  actor_email text,
  detail jsonb
)
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  IF NOT is_super_admin() THEN
    RAISE EXCEPTION 'forbidden';
  END IF;

  RETURN QUERY
  SELECT
    al.id,
    al.at,
    al.action,
    al.object_type,
    al.object_id,
    COALESCE(p.full_name, 'system'),
    p.role,
    p.email,
    al.detail
  FROM public.audit_log al
  LEFT JOIN public.profiles p ON p.id = al.actor_id
  ORDER BY al.at DESC
  LIMIT GREATEST(1, LEAST(COALESCE(p_limit, 200), 1000));
END;
$$;

GRANT EXECUTE ON FUNCTION
  admin_create_institution(text, text),
  admin_create_school(uuid, text),
  admin_create_department(uuid, uuid, text, text),
  admin_invite(text, user_role, text, uuid, uuid, uuid),
  admin_set_active(uuid, boolean),
  admin_update_plan_caps(plan_tier, integer, integer),
  admin_create_subscription_request(uuid, plan_tier, date, integer, text),
  decide_subscription(uuid, boolean, plan_tier, date, integer),
  admin_set_faculty_plan(uuid, plan_tier),
  ai_usage(uuid),
  consume_ai_credit(text, uuid),
  ai_usage_report(),
  admin_audit_feed(integer)
TO authenticated;
