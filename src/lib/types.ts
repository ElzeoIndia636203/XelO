import type { UserRole } from './logic/routing';

export type PlanTier = 'pro' | 'elite';
export type SubscriptionStatus = 'sent' | 'approved' | 'rejected';

export interface Institution {
  id: string;
  name: string;
  email_domain: string;
  plan: PlanTier | null;
  plan_start: string | null;
  plan_end: string | null;
  min_attendance_pct: number;
  attainment_threshold_pct: number;
  level_1_pct: number;
  level_2_pct: number;
  level_3_pct: number;
  internal_weight: number;
  endsem_weight: number;
  created_at: string;
}

export interface School {
  id: string;
  institution_id: string;
  name: string;
  dean_id: string | null;
}

export interface Department {
  id: string;
  institution_id: string;
  school_id: string;
  code: string;
  name: string;
  hod_id: string | null;
}

export interface Profile {
  id: string;
  institution_id: string | null;
  email: string;
  full_name: string;
  role: UserRole;
  school_id: string | null;
  department_id: string | null;
  roll_no: string | null;
  active: boolean;
  plan_override: PlanTier | null;
  calendar_token: string;
  created_at: string;
}

export interface Invite {
  id: string;
  email: string;
  institution_id: string | null;
  role: UserRole;
  full_name: string;
  school_id: string | null;
  department_id: string | null;
  roll_no: string | null;
  created_at: string;
  accepted_at: string | null;
}

export interface Plan {
  tier: PlanTier;
  total_cap: number;
  daily_cap: number;
}

export interface SubscriptionRequest {
  id: string;
  institution_id: string;
  requested_by: string | null;
  scope_label: string;
  plan: PlanTier;
  start_date: string;
  months: 3 | 6 | 12;
  status: SubscriptionStatus;
  decided_by: string | null;
  decided_at: string | null;
  created_at: string;
}

export interface AiUsageReportRow {
  user_id: string;
  full_name: string;
  email: string;
  institution_id: string;
  institution_name: string;
  tier: PlanTier | null;
  plan_end: string | null;
  total_cap: number;
  daily_cap: number;
  total_used: number;
  today_used: number;
  plan_active: boolean;
}

export interface AuditFeedRow {
  id: string;
  at: string;
  action: string;
  object_type: string;
  object_id: string | null;
  actor_name: string;
  actor_role: UserRole | null;
  actor_email: string | null;
  institution_id?: string | null;
  institution_name?: string | null;
  detail: Record<string, unknown>;
}

export type PlanApprovalStatus = 'draft' | 'sent' | 'approved' | 'declined';
export type SessionStatus = 'none' | 'draft' | 'active' | 'conducted';

export interface RubricWeights {
  att: number;
  pre: number;
  post: number;
  vis: number;
  hid: number;
  viva: number;
}

export interface Course {
  id: string;
  institution_id: string;
  department_id: string;
  faculty_id: string;
  code: string;
  title: string;
  ltpc: string;
  programme: string;
  semester: string;
  section: string;
  academic_year: string;
  plan_status: PlanApprovalStatus;
  plan_remark: string | null;
  rubric: RubricWeights;
  allowed_langs: string[];
  attainment_target: number;
  final_status: string;
  created_at: string;
}

export interface CourseOutcome {
  id: string;
  course_id: string;
  institution_id: string;
  code: string;
  statement: string;
  btl: number;
  unit: number;
}

export interface CoPoMapRow {
  id: string;
  course_id: string;
  institution_id: string;
  co_id: string;
  po_code: string;
  level: number;
}

export interface Batch {
  id: string;
  course_id: string;
  institution_id: string;
  name: string;
  class_code: string;
  slot: string;
  room: string;
  staff: string;
  created_at: string;
}

export interface Enrollment {
  id: string;
  course_id: string;
  batch_id: string;
  institution_id: string;
  student_id: string;
  created_at: string;
}

export interface PendingEnrollment {
  id: string;
  course_id: string;
  batch_id: string;
  institution_id: string;
  email: string;
  roll_no: string;
  full_name: string;
  created_at: string;
}

export interface SessionRow {
  id: string;
  course_id: string;
  institution_id: string;
  n: number;
  topic: string;
  co_id: string | null;
  btl: number;
  scheduled_date: string | null;
  status: SessionStatus;
  pre_open: string | null;
  pre_close: string | null;
  post_close: string | null;
  created_at: string;
}

export interface HolidayRow {
  id: string;
  institution_id: string;
  day: string;
  label: string;
}

export interface AiUsageSummary {
  tier: PlanTier | null;
  plan_start: string | null;
  plan_end: string | null;
  total_cap: number;
  daily_cap: number;
  total_used: number;
  today_used: number;
  plan_active: boolean;
}

export type QuestionDifficulty = 'easy' | 'medium' | 'hard';
export type QuestionStatus = 'candidate' | 'approved' | 'rejected';
export type QuestionSource = 'ai' | 'faculty';
export type BankType = 'pre' | 'post';

export interface QuestionRow {
  id: string;
  institution_id: string;
  course_id: string;
  kind: 'lab' | 'endsem' | 'task';
  session_id: string | null;
  assessment_id: string | null;
  co_code: string;
  difficulty: QuestionDifficulty;
  title: string;
  statement: string;
  input_spec: string;
  output_spec: string;
  constraints: string;
  starter_code: Record<string, string>;
  status: QuestionStatus;
  source: QuestionSource;
  valid: boolean | null;
  validation_note: string | null;
  created_by: string | null;
  created_at: string;
}

export interface TestCaseRow {
  id: string;
  institution_id: string;
  question_id: string;
  ord: number;
  input: string;
  expected: string;
  hidden: boolean;
  marks: number;
}

export interface ReferenceSolutionRow {
  id: string;
  institution_id: string;
  question_id: string;
  lang: string;
  code: string;
}

export interface SessionQuestionRow {
  id: string;
  institution_id: string;
  session_id: string;
  slot: 1 | 2;
  question_id: string;
}

export interface BankItemRow {
  id: string;
  institution_id: string;
  session_id: string;
  bank: BankType;
  level: QuestionDifficulty;
  stem: string;
  options: string[];
  answer: number;
  approved: boolean;
  created_at: string;
}

export interface SubmissionRow {
  id: string;
  institution_id: string;
  course_id: string;
  session_id: string | null;
  session_run_id: string | null;
  exam_paper_id: string | null;
  student_id: string;
  question_id: string;
  context: 'lab' | 'exam';
  mode: 'run' | 'submit';
  lang: string;
  code: string;
  visible_passed: number;
  visible_total: number;
  hidden_passed: number;
  hidden_total: number;
  marks: number;
  verdict: string;
  runtime_ms: number;
  memory_kb: number;
  created_at: string;
}

export type AttendanceState = 'present' | 'late' | 'absent';

export interface SessionRunRow {
  id: string;
  institution_id: string;
  session_id: string;
  batch_id: string;
  started_at: string | null;
  ended_at: string | null;
  attendance_done: boolean;
  post_close: string | null;
  remark: string;
  created_at: string;
}

export interface AttendanceRow {
  id: string;
  institution_id: string;
  session_run_id: string | null;
  assessment_id: string | null;
  student_id: string;
  state: AttendanceState;
  marked_by: string | null;
  at: string;
}

export interface TestAttemptRow {
  id: string;
  institution_id: string;
  session_id: string;
  student_id: string;
  bank: BankType;
  item_ids: string[];
  answers: Record<string, number>;
  score: number | null;
  started_at: string;
  submitted_at: string | null;
}

export interface DraftRow {
  id: string;
  institution_id: string;
  student_id: string;
  question_id: string;
  context: 'lab' | 'exam';
  lang: string;
  code: string;
  updated_at: string;
}

export interface VivaRow {
  id: string;
  institution_id: string;
  session_id: string | null;
  assessment_id: string | null;
  student_id: string;
  marks: number;
  examiner_id: string;
  updated_at: string;
}

export interface CourseFlagRow {
  id: string;
  institution_id: string;
  course_id: string;
  student_id: string;
  kind: 'slow' | 'fast';
  note: string;
  created_by: string | null;
  created_at: string;
}

export interface NotificationRow {
  id: string;
  institution_id: string;
  user_id: string;
  kind: string;
  title: string;
  body: string;
  link: string;
  read_at: string | null;
  created_at: string;
}

export type ClassItemKind = 'task' | 'resource' | 'announcement';
export type ClassTaskType = 'quiz' | 'fill' | 'predict' | 'debug' | 'assignment' | 'poll';

export interface ClassItemRow {
  id: string;
  institution_id: string;
  course_id: string;
  week: number;
  kind: ClassItemKind;
  task_type: ClassTaskType | null;
  title: string;
  body: string;
  payload: {
    code?: string;
    options?: string[];
  };
  due_at: string | null;
  url: string | null;
  file_path: string | null;
  created_by: string | null;
  created_at: string;
}

export interface ClassAnswerKeyRow {
  item_id: string;
  institution_id: string;
  answer: {
    expected?: string;
    accept?: string[];
  };
}

export interface ClassResponseRow {
  id: string;
  institution_id: string;
  item_id: string;
  student_id: string;
  answer: {
    value?: string;
  };
  score: number | null;
  submitted_at: string;
}

export interface CourseNotesRow {
  id: string;
  institution_id: string;
  course_id: string;
  bos_suggestions: string;
  internal_summary: string;
  overall_summary: string;
  updated_by: string | null;
  updated_at: string;
}

export interface CourseSnapshotRow {
  id: string;
  institution_id: string;
  course_id: string;
  students: number;
  internal_mean: number;
  below_40: number;
  co_internal: Record<string, number>;
  co_overall: Record<string, number>;
  overall_pct: number;
  computed_at: string;
}

export interface VerifyLabFileResult {
  found: boolean;
  institution_name?: string;
  course_code?: string;
  course_title?: string;
  academic_year?: string;
  semester?: string;
  student_name?: string;
  roll_no?: string;
  attendance_pct?: number;
  internal_out_of_100?: number;
  final_status?: string;
  verification_code?: string;
}

