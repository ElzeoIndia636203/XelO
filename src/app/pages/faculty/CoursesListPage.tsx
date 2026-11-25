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
import type { Course, Department } from '../../../lib/types';

export function CoursesListPage() {
  const { profile, institution, signOut } = useSession();
  const navigate = useNavigate();
  const [modalOpen, setModalOpen] = useState(false);
  const [code, setCode] = useState('');
  const [title, setTitle] = useState('');
  const [ltpc, setLtpc] = useState('0-0-2-1');
  const [programme, setProgramme] = useState('B.Tech');
  const [semester, setSemester] = useState('IV');
  const [section, setSection] = useState('SY-B');
  const [year, setYear] = useState('2026-27');
  const [deptId, setDeptId] = useState(profile?.department_id ?? '');
  const [busy, setBusy] = useState(false);
  const [formErr, setFormErr] = useState<string | null>(null);

  const { data, loading, error, reload } = useLoad(async () => {
    const [courses, departments] = await Promise.all([
      fetchAll<Course>((from, to) =>
        supabase
          .from('courses')
          .select('*')
          .eq('faculty_id', profile?.id ?? '')
          .order('created_at', { ascending: false })
          .range(from, to),
      ),
      fetchAll<Department>((from, to) =>
        supabase.from('departments').select('*').order('name').range(from, to),
      ),
    ]);
    return { courses, departments };
  }, [profile?.id]);

  async function handleCreate(e: FormEvent) {
    e.preventDefault();
    setFormErr(null);
    setBusy(true);
    try {
      const targetDept = deptId || profile?.department_id || data?.departments[0]?.id || null;
      const newId = await rpc<string>('create_course', {
        p_code: code,
        p_title: title,
        p_ltpc: ltpc,
        p_programme: programme,
        p_semester: semester,
        p_section: section,
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
          {profile?.role === 'hod' ? (
            <Link to="/hod" style={{ color: '#CFCDC5', textDecoration: 'underline' }}>
              HOD console
            </Link>
          ) : null}
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
            <button type="button" className="btn btn-primary" onClick={() => setModalOpen(true)}>
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
              <button type="button" className="btn btn-primary" onClick={() => setModalOpen(true)}>
                New course
              </button>
            }
          />
        ) : null}

        {data && data.courses.length > 0 ? (
          <div className="grid-2">
            {data.courses.map((c) => (
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
                  <div>
                    <Link className="btn btn-primary" to={`/faculty/c/${c.id}/setup`}>
                      Open workspace
                    </Link>
                  </div>
                </div>
              </Card>
            ))}
          </div>
        ) : null}
      </main>

      <Modal open={modalOpen} title="New lab course" onClose={() => setModalOpen(false)}>
        <form onSubmit={handleCreate} style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
          {formErr ? <Banner tone="err">{formErr}</Banner> : null}
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
              L-T-P-C
              <input
                className="field mono"
                required
                value={ltpc}
                onChange={(e) => setLtpc(e.target.value)}
                placeholder="0-0-2-1"
              />
            </label>
          </div>
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
          <div className="grid-2">
            <label className="field-label">
              Programme
              <input
                className="field"
                value={programme}
                onChange={(e) => setProgramme(e.target.value)}
              />
            </label>
            <label className="field-label">
              Department
              <select
                className="field"
                value={deptId || profile?.department_id || data?.departments[0]?.id || ''}
                onChange={(e) => setDeptId(e.target.value)}
              >
                {(data?.departments ?? []).map((d) => (
                  <option key={d.id} value={d.id}>
                    {d.code} · {d.name}
                  </option>
                ))}
              </select>
            </label>
            <label className="field-label">
              Semester
              <input
                className="field"
                value={semester}
                onChange={(e) => setSemester(e.target.value)}
              />
            </label>
            <label className="field-label">
              Section
              <input
                className="field"
                value={section}
                onChange={(e) => setSection(e.target.value)}
              />
            </label>
          </div>
          <label className="field-label">
            Academic year
            <input
              className="field mono"
              value={year}
              onChange={(e) => setYear(e.target.value)}
            />
          </label>
          <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8, marginTop: 4 }}>
            <button type="button" className="btn" onClick={() => setModalOpen(false)}>
              Cancel
            </button>
            <button type="submit" className="btn btn-primary" disabled={busy}>
              {busy ? 'Creating…' : 'Create course'}
            </button>
          </div>
        </form>
      </Modal>
    </div>
  );
}

export default CoursesListPage;
