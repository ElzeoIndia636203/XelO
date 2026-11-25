-- Local development seed for Sanjivani University pilot

DO $$
DECLARE
  v_inst uuid := '10000000-0000-0000-0000-000000000001';
  v_set uuid := '20000000-0000-0000-0000-000000000001';
  v_scm uuid := '20000000-0000-0000-0000-000000000002';
  v_cse uuid := '30000000-0000-0000-0000-000000000001';
  v_it uuid := '30000000-0000-0000-0000-000000000002';
BEGIN
  INSERT INTO institutions (id, name, email_domain, plan, plan_start, plan_end)
  VALUES (v_inst, 'Sanjivani University', 'sanjivani.edu.in', 'pro', CURRENT_DATE, (CURRENT_DATE + interval '6 months' - interval '1 day')::date)
  ON CONFLICT (email_domain) DO NOTHING;

  INSERT INTO schools (id, institution_id, name)
  VALUES
    (v_set, v_inst, 'School of Engineering and Technology'),
    (v_scm, v_inst, 'School of Commerce and Management')
  ON CONFLICT (institution_id, name) DO NOTHING;

  INSERT INTO departments (id, institution_id, school_id, code, name)
  VALUES
    (v_cse, v_inst, v_set, 'CSE', 'Computer Science and Engineering'),
    (v_it, v_inst, v_set, 'IT', 'Information Technology')
  ON CONFLICT (institution_id, code) DO NOTHING;

  INSERT INTO holidays (institution_id, day, label)
  VALUES
    (v_inst, '2027-01-26', 'Republic Day'),
    (v_inst, '2027-03-04', 'University Holiday')
  ON CONFLICT (institution_id, day) DO NOTHING;

  INSERT INTO invites (email, institution_id, role, full_name, school_id, department_id)
  VALUES
    ('superadmin@elzeo.in', NULL, 'super_admin', 'Elzeo Super Admin', NULL, NULL),
    ('vc@sanjivani.edu.in', v_inst, 'vc', 'Vice-Chancellor', NULL, NULL),
    ('coe@sanjivani.edu.in', v_inst, 'coe', 'Controller of Examinations', NULL, NULL),
    ('dean.set@sanjivani.edu.in', v_inst, 'dean', 'Dean, SET', v_set, NULL),
    ('hod.cse@sanjivani.edu.in', v_inst, 'hod', 'HOD, CSE', v_set, v_cse),
    ('faculty.demo@sanjivani.edu.in', v_inst, 'faculty', 'Demo Faculty', v_set, v_cse),
    ('student.demo@sanjivani.edu.in', v_inst, 'student', 'Demo Student', v_set, v_cse)
  ON CONFLICT (email) DO NOTHING;
END $$;
