import { useState, type FormEvent } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import {
  Banner,
  Card,
  Chip,
  Elzeo,
  Empty,
  ErrorNote,
  Loading,
  Modal,
  PageHead,
  Wordmark,
  statusTone,
} from '../../../components/ui';
import { errorMessage } from '../../../lib/errors';
import { useLoad } from '../../../lib/hooks';
import { useSession } from '../../../lib/session';
import { fetchAll, rpc, supabase } from '../../../lib/supabase';
import { FeedbackInsightsCard } from '../../components/FeedbackInsightsCard';
import { HierarchyMeetingsCard } from '../../components/HierarchyMeetingsCard';
import { RolePortalToggle } from '../../components/RolePortalToggle';
import type { Course, Department, School } from '../../../lib/types';

const CLASS_YEARS = ['I Yr', 'II Yr', 'III Yr', 'IV Yr', 'V Yr'] as const;

export function CoursesListPage() {
  const { profile, institution, signOut } = useSession();
  const navigate = useNavigate();
  const [modalOpen, setModalOpen] = useState(false);
  const [editingCourseId, setEditingCourseId] = useState<string | null>(null);
  const [schoolId, setSchoolId] = useState('');
  const [programme, setProgramme] = useState('B.Tech');
  const [deptId, setDeptId] = useState(profile?.department_id ?? '');
  const [year, setYear] = useState('2026-27');
  const [classYear, setClassYear] = useState<string>('II Yr');
  const [semester, setSemester] = useState('IV');
  const [code, setCode] = useState('');
  const [title, setTitle] = useState('');
  const [ltpc, setLtpc] = useState('0-0-2-1');
  const [labHours, setLabHours] = useState<number>(1);
  const [busy, setBusy] = useState(false);
  const [formErr, setFormErr] = useState<string | null>(null);

  const { data, loading, error, reload } = useLoad(async () => {
    const [courses, schools, departments] = await Promise.all([
      fetchAll<Course>((from, to) =>
        supabase
          .from('courses')
          .select('*')
          .eq('faculty_id', profile?.id ?? '')
          .order('created_at', { ascending: false })
          .range(from, to),
      ),
      fetchAll<School>((from, to) =>
        supabase.from('schools').select('*').order('name').range(from, to),
      ).catch(() => [] as School[]),
      fetchAll<Department>((from, to) =>
        supabase.from('departments').select('*').order('name').range(from, to),
      ),
    ]);
    return { courses, schools, departments };
  }, [profile?.id]);

  const activeSchoolId =
    schoolId ||
    profile?.school_id ||
    data?.departments.find((d) => d.id === (deptId || profile?.department_id))?.school_id ||
    data?.schools[0]?.id ||
    '';

  const visibleDepartments = (data?.departments ?? []).filter(
    (d) => !activeSchoolId || d.school_id === activeSchoolId,
  );
  const activeDeptId =
    visibleDepartments.find((d) => d.id === (deptId || profile?.department_id))?.id ||
    visibleDepartments[0]?.id ||
    '';

  function openNewModal() {
    setEditingCourseId(null);
    setFormErr(null);
    setCode('');
    setTitle('');
    setLtpc('0-0-2-1');
    setProgramme('B.Tech');
    setSemester('IV');
    setClassYear('II Yr');
    setYear('2026-27');
    setLabHours(1);
    setModalOpen(true);
  }

  function openEditModal(c: Course) {
    setEditingCourseId(c.id);
    setFormErr(null);
    const dept = data?.departments.find((d) => d.id === c.department_id);
    setSchoolId(dept?.school_id ?? '');
    setDeptId(c.department_id ?? '');
    setProgramme(c.programme);
    setYear(c.academic_year);
    setClassYear(c.section || 'II Yr');
    setSemester(c.semester);
    setCode(c.code);
    setTitle(c.title);
    setLtpc(c.ltpc);
    setLabHours(1);
    setModalOpen(true);
  }

  async function handleDelete(c: Course) {
    if (!window.confirm(`Delete draft course ${c.code} · ${c.title}?`)) return;
    setBusy(true);
    try {
      const { error: delErr } = await supabase.from('courses').delete().eq('id', c.id);
      if (delErr) throw new Error(delErr.message);
      reload();
    } catch (err) {
      setFormErr(errorMessage(err));
    } finally {
      setBusy(false);
    }
  }

  async function handleCreate(e: FormEvent) {
    e.preventDefault();
    setFormErr(null);
    setBusy(true);
    try {
      const targetDept = activeDeptId || profile?.department_id || data?.departments[0]?.id || null;
      if (editingCourseId) {
        const { error: updErr } = await supabase
          .from('courses')
          .update({
            code: code.trim(),
            title: title.trim(),
            ltpc: ltpc.trim(),
            programme: programme.trim() || 'B.Tech',
            semester: semester.trim(),
            section: classYear,
            academic_year: year.trim(),
            department_id: targetDept,
          })
          .eq('id', editingCourseId);
        if (updErr) throw new Error(updErr.message);
        setModalOpen(false);
        setEditingCourseId(null);
        reload();
        return;
      }

      const newId = await rpc<string>('create_course', {
        p_code: code,
        p_title: title,
        p_ltpc: ltpc,
        p_programme: programme,
        p_semester: semester,
        p_section: classYear,
        p_academic_year: year,
        p_department_id: targetDept,
      });
      setModalOpen(false);
      setCode('');
      setTitle('');
      reload();
      navigate(`/faculty/c/${newId}/setup`);
    } catch (err) {
      setFormErr(errorMessage(err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div style={{ minHeight: '100vh', background: 'var(--paper)' }}>
      <header
        className="dark-surface no-print"
        style={{
          background: 'var(--rail)',
          color: '#FFFFFF',
          padding: '12px 24px',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'space-between',
          gap: 12,
        }}
      >
        <div style={{ display: 'flex', alignItems: 'center', gap: 14 }}>
          <Wordmark dark sub="Assist" />
          <Elzeo dark />
        </div>
        <div style={{ display: 'flex', alignItems: 'center', gap: 12, fontSize: 13 }}>
          {profile?.role === 'hod' ? <RolePortalToggle active="faculty" dark /> : null}
          <span className="mono" style={{ color: '#CFCDC5' }}>
            {profile?.email}
          </span>
          <button
            type="button"
            className="btn"
            style={{ background: '#2C2B28', color: '#FFFFFF', borderColor: '#3E3D39' }}
            onClick={() => void signOut()}
          >
            Sign out
          </button>
        </div>
      </header>

      <main style={{ maxWidth: 1080, margin: '0 auto', padding: '28px 20px', display: 'flex', flexDirection: 'column', gap: 16 }}>
        <PageHead
          kicker={`FACULTY WORKSPACE · ${institution?.name ?? 'XEIO'}`}
          title="My courses"
          lead="Manage lab course setup, batches, session plans, and live labs."
          actions={
            <button type="button" className="btn btn-primary" onClick={openNewModal}>
              New course
            </button>
          }
        />

        {error ? <ErrorNote message={error} /> : null}
        {loading && !data ? <Loading /> : null}

        {data && data.courses.length === 0 ? (
          <Empty
            title="No courses yet"
            body="Create your first programming lab course to configure COs, rubric, batches, and session plan."
            action={
              <button type="button" className="btn btn-primary" onClick={openNewModal}>
                New course
              </button>
            }
          />
        ) : null}

        {data && data.courses.length > 0 ? (
          <div className="grid-2">
            {data.courses.map((c) => {
              const canEdit = c.plan_status === 'draft' || c.plan_status === 'declined';
              const canDelete = c.plan_status === 'draft';
              return (
                <Card
                  key={c.id}
                  title={`${c.code} · ${c.title}`}
                  actions={<Chip tone={statusTone(c.plan_status)}>{c.plan_status}</Chip>}
                >
                  <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
                    <div className="mono" style={{ fontSize: 12, color: 'var(--muted)' }}>
                      {c.section} · Sem {c.semester} · {c.academic_year} · L-T-P-C {c.ltpc}
                    </div>
                    {c.plan_status === 'declined' && c.plan_remark ? (
                      <Banner tone="err">HOD remark: {c.plan_remark}</Banner>
                    ) : null}
                    <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8 }}>
                      <Link className="btn btn-primary" to={`/faculty/c/${c.id}/setup`}>
                        Open workspace
                      </Link>
                      {canEdit ? (
                        <button
                          type="button"
                          className="btn"
                          disabled={busy}
                          onClick={() => openEditModal(c)}
                        >
                          Edit
                        </button>
                      ) : null}
                      {canDelete ? (
                        <button
                          type="button"
                          className="btn"
                          disabled={busy}
                          onClick={() => void handleDelete(c)}
                        >
                          Delete
                        </button>
                      ) : null}
                    </div>
                  </div>
                </Card>
              );
            })}
          </div>
        ) : null}

        <FeedbackInsightsCard />
        <HierarchyMeetingsCard
          title="Notifications & meetings (Students / HOD / Dean)"
          allowNotify
          allowRequest
        />
      </main>

      <Modal
        open={modalOpen}
        title={editingCourseId ? 'Edit lab course' : 'New lab course'}
        onClose={() => {
          setModalOpen(false);
          setEditingCourseId(null);
        }}
      >
        <form onSubmit={handleCreate} style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
          {formErr ? <Banner tone="err">{formErr}</Banner> : null}
          <div className="grid-2">
            <label className="field-label">
              School
              <select
                className="field"
                value={activeSchoolId}
                onChange={(e) => {
                  setSchoolId(e.target.value);
                  setDeptId('');
                }}
              >
                {(data?.schools ?? []).length === 0 ? <option value="">Default school</option> : null}
                {(data?.schools ?? []).map((s) => (
                  <option key={s.id} value={s.id}>
                    {s.name}
                  </option>
                ))}
              </select>
            </label>
            <label className="field-label">
              Programme
              <input
                className="field"
                required
                value={programme}
                onChange={(e) => setProgramme(e.target.value)}
                placeholder="B.Tech"
              />
            </label>
          </div>
          <div className="grid-2">
            <label className="field-label">
              Department
              <select
                className="field"
                value={activeDeptId}
                onChange={(e) => setDeptId(e.target.value)}
              >
                {visibleDepartments.map((d) => (
                  <option key={d.id} value={d.id}>
                    {d.code} · {d.name}
                  </option>
                ))}
              </select>
            </label>
            <label className="field-label">
              Academic year
              <input
                className="field mono"
                required
                value={year}
                onChange={(e) => setYear(e.target.value)}
                placeholder="2026-27"
              />
            </label>
          </div>
          <div className="grid-2">
            <label className="field-label">
              Class
              <select
                className="field"
                value={classYear}
                onChange={(e) => setClassYear(e.target.value)}
              >
                {CLASS_YEARS.map((yr) => (
                  <option key={yr} value={yr}>
                    {yr}
                  </option>
                ))}
              </select>
            </label>
            <label className="field-label">
              Semester
              <input
                className="field"
                required
                value={semester}
                onChange={(e) => setSemester(e.target.value)}
                placeholder="IV"
              />
            </label>
          </div>
          <div className="grid-2">
            <label className="field-label">
              Course code
              <input
                className="field mono"
                required
                value={code}
                onChange={(e) => setCode(e.target.value)}
                placeholder="CSL-101"
              />
            </label>
            <label className="field-label">
              Course title
              <input
                className="field"
                required
                value={title}
                onChange={(e) => setTitle(e.target.value)}
                placeholder="Programming in C Lab"
              />
            </label>
          </div>
          <div className="grid-2">
            <label className="field-label">
              L-T-P-C
              <input
                className="field mono"
                required
                value={ltpc}
                onChange={(e) => setLtpc(e.target.value)}
                placeholder="0-0-2-1"
              />
            </label>
            <label className="field-label">
              Number of lab hours
              <input
                className="field mono"
                type="number"
                min={1}
                required
                value={labHours}
                onChange={(e) => setLabHours(Math.max(1, Number(e.target.value) || 1))}
              />
              <span style={{ fontSize: 11, color: 'var(--muted)' }}>
                1 hour = 2 sessions ({labHours * 2} sessions)
              </span>
            </label>
          </div>
          <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8, marginTop: 4 }}>
            <button type="button" className="btn" onClick={() => setModalOpen(false)}>
              Cancel
            </button>
            <button type="submit" className="btn btn-primary" disabled={busy}>
              {busy ? (editingCourseId ? 'Saving…' : 'Creating…') : editingCourseId ? 'Save changes' : 'Create course'}
            </button>
          </div>
        </form>
      </Modal>
    </div>
  );
}

export default CoursesListPage;
