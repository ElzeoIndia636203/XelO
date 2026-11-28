import { useState } from 'react';
import { Link, useParams, useSearchParams } from 'react-router-dom';
import { Card, Chip, Empty, ErrorNote, Loading } from '../../../components/ui';
import { DigitalReportFooter } from '../../../components/DigitalReportFooter';
import { loadCourseData, computeReport, type ComputedStudentReportRow } from '../../../lib/api/report';
import { errorMessage } from '../../../lib/errors';
import { formatDateIst, formatDateTimeIst, formatTimeIst } from '../../../lib/format';
import { useLoad } from '../../../lib/hooks';
import { qrSvgData, verificationCode } from '../../../lib/logic/qr';
import { useSession } from '../../../lib/session';
import { fetchAll, supabase } from '../../../lib/supabase';
import type { Course, Department, Enrollment, Profile, School } from '../../../lib/types';
import { StudentShell } from './StudentShell';

interface LabFileMeta {
  institutionName: string;
  schoolName: string;
  departmentName: string;
  facultyName: string;
  course: Course;
  row: ComputedStudentReportRow;
}

function LabFileDocument({
  meta,
  backLink,
  backLabel,
}: {
  meta: LabFileMeta;
  backLink?: string;
  backLabel?: string;
}) {
  const [openProgramKeys, setOpenProgramKeys] = useState<Set<string>>(() => new Set());
  const { course, row } = meta;
  const generatedAt = formatDateTimeIst(new Date().toISOString());
  const roll = row.student.roll_no ?? '—';
  const verifyId = verificationCode(course.code, row.student.roll_no ?? '', row.student.id);
  const siteBase = (import.meta.env.VITE_SITE_URL || window.location.origin).replace(/\/+$/, '');
  const verifyUrl = `${siteBase}/app/verify/${course.id}/${row.student.id}`;
  const qr = qrSvgData(verifyUrl);

  const allProgramKeys = row.programs
    .filter((p) => Boolean(p.submission?.code))
    .map((p) => `${p.sessionId}:${p.questionId}`);
  const allOpen =
    allProgramKeys.length > 0 && allProgramKeys.every((k) => openProgramKeys.has(k));

  function toggleAll() {
    if (allOpen) {
      setOpenProgramKeys(new Set());
    } else {
      setOpenProgramKeys(new Set(allProgramKeys));
    }
  }

  function toggleOne(key: string) {
    setOpenProgramKeys((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  }

  const r = course.rubric;
  const rubricComponents = [
    { name: `Attendance (${r.att} per session)`, earned: row.rubricTotals.att, max: row.sessions.filter((s) => s.conducted).length * r.att },
    { name: `Pre-test (${r.pre} per session)`, earned: row.rubricTotals.pre, max: row.sessions.filter((s) => s.conducted).length * r.pre },
    { name: `Post-test (${r.post} per session)`, earned: row.rubricTotals.post, max: row.sessions.filter((s) => s.conducted).length * r.post },
    { name: `Visible test cases (${r.vis} per session)`, earned: row.rubricTotals.vis, max: row.sessions.filter((s) => s.conducted).length * r.vis },
    { name: `Hidden test cases (${r.hid} per session)`, earned: row.rubricTotals.hid, max: row.sessions.filter((s) => s.conducted).length * r.hid },
    { name: `Viva (${r.viva} per session)`, earned: row.rubricTotals.viva, max: row.sessions.filter((s) => s.conducted).length * r.viva },
  ];

  const pageBoxStyle = {
    maxWidth: 780,
    width: '100%',
    margin: '0 auto',
    background: '#FFFFFF',
    border: '1px solid var(--border)',
    borderRadius: 6,
    padding: '44px 42px',
  } as const;

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 18 }}>
      <div
        className="no-print"
        style={{
          maxWidth: 780,
          width: '100%',
          margin: '0 auto',
          display: 'flex',
          flexWrap: 'wrap',
          justifyContent: 'space-between',
          alignItems: 'center',
          gap: 10,
        }}
      >
        <div>
          <h1 style={{ fontSize: 22, fontWeight: 600 }}>Lab file · {course.code}</h1>
          <div style={{ fontSize: 12, color: 'var(--muted)' }}>
            As of today. The final file is issued after the last working day and is needed to appear for the final practical.
          </div>
        </div>

        <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8 }}>
          {backLink ? (
            <Link className="btn field-sm" to={backLink}>
              {backLabel ?? 'Back'}
            </Link>
          ) : null}
          <button type="button" className="btn field-sm" onClick={toggleAll}>
            {allOpen ? 'Hide all code' : 'Show all code'}
          </button>
          <button type="button" className="btn btn-primary field-sm" onClick={() => window.print()}>
            Download PDF
          </button>
        </div>
      </div>

      {/* Page 1: Title page */}
      <section
        className="lab-file-page"
        aria-label="Title page"
        style={{
          ...pageBoxStyle,
          minHeight: 760,
          display: 'flex',
          flexDirection: 'column',
          alignItems: 'center',
          textAlign: 'center',
          gap: 14,
          fontFamily: "'IBM Plex Serif', Georgia, serif",
        }}
      >
        <div
          style={{
            fontSize: 13,
            letterSpacing: 2,
            textTransform: 'uppercase',
            color: 'var(--muted)',
            fontFamily: 'var(--font-sans)',
          }}
        >
          {meta.institutionName}
        </div>
        <div style={{ fontSize: 15 }}>
          {meta.schoolName}
          <br />
          Department of {meta.departmentName}
        </div>

        <div style={{ marginTop: 48, fontSize: 32, fontWeight: 600 }}>Laboratory Record</div>
        <div style={{ fontSize: 20 }}>
          {course.code} · {course.title}
        </div>
        <div style={{ fontSize: 14, color: 'var(--muted)' }}>
          L-T-P-C {course.ltpc} · Semester {course.semester} · Academic year {course.academic_year}
        </div>

        <table
          style={{
            marginTop: 40,
            borderCollapse: 'collapse',
            fontSize: 15,
            textAlign: 'left',
            fontFamily: 'var(--font-sans)',
            width: '100%',
            maxWidth: 460,
          }}
        >
          <tbody>
            <tr>
              <td style={{ padding: '8px 20px 8px 0', color: 'var(--muted)', borderBottom: 0 }}>Name</td>
              <td style={{ padding: '8px 0', borderBottom: '1px solid #D6D3C9' }}>{row.student.full_name}</td>
            </tr>
            <tr>
              <td style={{ padding: '8px 20px 8px 0', color: 'var(--muted)', borderBottom: 0 }}>Roll number</td>
              <td className="mono" style={{ padding: '8px 0', borderBottom: '1px solid #D6D3C9' }}>{roll}</td>
            </tr>
            <tr>
              <td style={{ padding: '8px 20px 8px 0', color: 'var(--muted)', borderBottom: 0 }}>Class and batch</td>
              <td style={{ padding: '8px 0', borderBottom: '1px solid #D6D3C9' }}>
                {course.section} · {row.batch?.name ?? 'Batch'}
              </td>
            </tr>
            <tr>
              <td style={{ padding: '8px 20px 8px 0', color: 'var(--muted)', borderBottom: 0 }}>Faculty in-charge</td>
              <td style={{ padding: '8px 0', borderBottom: '1px solid #D6D3C9' }}>{meta.facultyName}</td>
            </tr>
          </tbody>
        </table>

        <div style={{ marginTop: 'auto', width: '100%', fontFamily: 'var(--font-sans)' }}>
          <DigitalReportFooter
            facultyName={meta.facultyName}
            timestamp={generatedAt}
            universityName={meta.institutionName}
            inlineOnly
          />
        </div>
      </section>

      {/* Page 2: Declaration */}
      <section
        className="lab-file-page"
        aria-label="Declaration"
        style={{
          ...pageBoxStyle,
          minHeight: 720,
          display: 'flex',
          flexDirection: 'column',
          gap: 18,
        }}
      >
        <div
          style={{
            fontFamily: "'IBM Plex Serif', Georgia, serif",
            fontSize: 24,
            fontWeight: 600,
            textAlign: 'center',
          }}
        >
          Declaration
        </div>
        <p style={{ fontFamily: "'IBM Plex Serif', Georgia, serif", fontSize: 15, lineHeight: 1.8 }}>
          I, {row.student.full_name} (roll number {roll}), declare that every program recorded in this laboratory record is my own original work, written by me during the scheduled lab sessions. I have not copied code from other students or other sources, have not used AI tools to generate the code, and have not been involved in any act of indiscipline during the course. I submit this record for my appearance in the final laboratory practical examination of {course.code} {course.title}.
        </p>

        <div
          style={{
            display: 'flex',
            flexWrap: 'wrap',
            gap: 24,
            alignItems: 'center',
            justifyContent: 'space-between',
            padding: 20,
            border: '1px solid var(--ink)',
            borderRadius: 4,
          }}
        >
          <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
            <div>
              <div style={{ fontSize: 11, color: 'var(--muted)', textTransform: 'uppercase' }}>Internal marks</div>
              <div className="mono" style={{ fontSize: 34, fontWeight: 600 }}>
                {row.internalPct} <span style={{ fontSize: 16, color: 'var(--muted)' }}>/ 100</span>
              </div>
            </div>
            <div>
              <div style={{ fontSize: 11, color: 'var(--muted)', textTransform: 'uppercase' }}>Attendance</div>
              <div className="mono" style={{ fontSize: 22 }}>{row.attendancePct}%</div>
            </div>
            <div className="mono" style={{ fontSize: 11, color: 'var(--muted)' }}>
              Verification code {verifyId}
            </div>
            <div className="no-print">
              <Link to={`/verify/${course.id}/${row.student.id}`} style={{ fontSize: 12 }}>
                Open verification link
              </Link>
            </div>
          </div>

          <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 6 }}>
            <svg
              width="132"
              height="132"
              viewBox={`0 0 ${qr.size} ${qr.size}`}
              role="img"
              aria-label={`QR code to verify ${verifyId}`}
              shapeRendering="crispEdges"
            >
              <rect width={qr.size} height={qr.size} fill="#FFFFFF" />
              <path d={qr.path} fill="#141413" />
            </svg>
            <div style={{ fontSize: 11, color: 'var(--muted)' }}>Scan to verify on XeIO</div>
          </div>
        </div>

        <div style={{ marginTop: 'auto', width: '100%' }}>
          <DigitalReportFooter
            facultyName={meta.facultyName}
            timestamp={generatedAt}
            universityName={meta.institutionName}
            inlineOnly
          />
        </div>
      </section>

      {/* Page 3: Index */}
      <section
        className="lab-file-page"
        aria-label="Index"
        style={{
          ...pageBoxStyle,
          display: 'flex',
          flexDirection: 'column',
          gap: 14,
        }}
      >
        <div
          style={{
            fontFamily: "'IBM Plex Serif', Georgia, serif",
            fontSize: 22,
            fontWeight: 600,
            textAlign: 'center',
          }}
        >
          Index
        </div>

        <div style={{ overflowX: 'auto' }}>
          <table style={{ fontSize: 12 }}>
            <thead>
              <tr>
                <th>#</th>
                <th>Title</th>
                <th>Scheduled</th>
                <th>Status</th>
                <th style={{ textAlign: 'right' }}>Att</th>
                <th style={{ textAlign: 'right' }}>Pre</th>
                <th style={{ textAlign: 'right' }}>Post</th>
                <th style={{ textAlign: 'right' }}>Vis</th>
                <th style={{ textAlign: 'right' }}>Hid</th>
                <th style={{ textAlign: 'right' }}>Viva</th>
              </tr>
            </thead>
            <tbody>
              {row.sessions.map((s) => (
                <tr key={s.session.id}>
                  <td className="mono">{s.session.n}</td>
                  <td>{s.session.topic}</td>
                  <td className="mono" style={{ fontSize: 11, whiteSpace: 'nowrap' }}>
                    {s.session.scheduled_date ? formatDateIst(s.session.scheduled_date) : '—'}
                  </td>
                  <td>
                    <Chip
                      tone={
                        !s.conducted
                          ? 'neutral'
                          : s.attendance === 'absent'
                            ? 'bad'
                            : s.hidTotal > 0 && s.hidPassed >= s.hidTotal
                              ? 'good'
                              : 'warn'
                      }
                    >
                      {!s.conducted
                        ? 'Pending'
                        : s.attendance === 'absent'
                          ? 'Absent'
                          : s.hidTotal > 0 && s.hidPassed >= s.hidTotal
                            ? 'Passed'
                            : 'Submitted'}
                    </Chip>
                  </td>
                  <td className="mono" style={{ textAlign: 'right' }}>{s.conducted ? s.breakdown.att : '—'}</td>
                  <td className="mono" style={{ textAlign: 'right' }}>{s.conducted ? s.breakdown.pre : '—'}</td>
                  <td className="mono" style={{ textAlign: 'right' }}>{s.conducted ? s.breakdown.post : '—'}</td>
                  <td className="mono" style={{ textAlign: 'right' }}>{s.conducted ? s.breakdown.vis : '—'}</td>
                  <td className="mono" style={{ textAlign: 'right' }}>{s.conducted ? s.breakdown.hid : '—'}</td>
                  <td className="mono" style={{ textAlign: 'right' }}>{s.conducted ? s.breakdown.viva : '—'}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>

        <table style={{ fontSize: 13 }}>
          <thead>
            <tr>
              <th>Rubric component</th>
              <th style={{ textAlign: 'right' }}>Earned / Out of</th>
            </tr>
          </thead>
          <tbody>
            {rubricComponents.map((rb) => (
              <tr key={rb.name}>
                <td>{rb.name}</td>
                <td className="mono" style={{ textAlign: 'right' }}>
                  {rb.earned} / {rb.max}
                </td>
              </tr>
            ))}
            <tr style={{ fontWeight: 600 }}>
              <td>Total (scaled from {row.rubricTotals.total} / {row.rubricTotals.outOf})</td>
              <td className="mono" style={{ textAlign: 'right' }}>
                {row.internalPct} / 100
              </td>
            </tr>
          </tbody>
        </table>

        <div style={{ marginTop: 'auto', width: '100%' }}>
          <DigitalReportFooter
            facultyName={meta.facultyName}
            timestamp={generatedAt}
            universityName={meta.institutionName}
            inlineOnly
          />
        </div>
      </section>

      {/* Page 4: Record of submitted programs */}
      <section
        className="lab-file-page"
        aria-label="Record of submitted programs"
        style={{
          ...pageBoxStyle,
          display: 'flex',
          flexDirection: 'column',
          gap: 12,
        }}
      >
        <div
          style={{
            fontFamily: "'IBM Plex Serif', Georgia, serif",
            fontSize: 22,
            fontWeight: 600,
            textAlign: 'center',
          }}
        >
          Record of submitted programs
        </div>
        <div style={{ fontSize: 12, color: 'var(--muted)', textAlign: 'center' }}>
          Final submission for each question. Hidden test cases are shown as passed or pending only.
        </div>

        <div style={{ overflowX: 'auto' }}>
          <table style={{ fontSize: 12 }}>
            <thead>
              <tr>
                <th>Session</th>
                <th>Program</th>
                <th>Submitted</th>
                <th style={{ textAlign: 'right' }}>Visible</th>
                <th style={{ textAlign: 'right' }}>Hidden</th>
                <th>Status</th>
                <th className="no-print" />
              </tr>
            </thead>
            <tbody>
              {row.programs.length === 0 ? (
                <tr>
                  <td colSpan={7} style={{ textAlign: 'center', color: 'var(--muted)', padding: 14 }}>
                    No lab program submissions recorded yet.
                  </td>
                </tr>
              ) : (
                row.programs.map((prog) => {
                  const k = `${prog.sessionId}:${prog.questionId}`;
                  const sub = prog.submission;
                  const passedAll = sub && sub.hidden_total > 0 && sub.hidden_passed >= sub.hidden_total;
                  const open = openProgramKeys.has(k);

                  return (
                    <tr key={k}>
                      <td className="mono">S{prog.sessionNumber}</td>
                      <td>
                        <div>{prog.questionTitle}</div>
                        {open && sub?.code ? (
                          <pre
                            className="mono"
                            style={{
                              marginTop: 8,
                              padding: 10,
                              background: '#F6F5F1',
                              border: '1px solid var(--border-soft)',
                              borderRadius: 4,
                              fontSize: 11,
                              whiteSpace: 'pre-wrap',
                            }}
                          >
                            {sub.code}
                          </pre>
                        ) : null}
                      </td>
                      <td className="mono" style={{ fontSize: 11, whiteSpace: 'nowrap' }}>
                        {sub ? `${formatTimeIst(sub.created_at)} · ${sub.lang}` : '—'}
                      </td>
                      <td className="mono" style={{ textAlign: 'right' }}>
                        {sub ? `${sub.visible_passed}/${sub.visible_total}` : '—'}
                      </td>
                      <td className="mono" style={{ textAlign: 'right' }}>
                        {sub ? `${sub.hidden_passed}/${sub.hidden_total}` : '—'}
                      </td>
                      <td>
                        <Chip tone={passedAll ? 'good' : sub ? 'warn' : 'neutral'}>
                          {passedAll ? 'Passed' : sub ? 'Pending' : 'None'}
                        </Chip>
                      </td>
                      <td className="no-print" style={{ textAlign: 'right' }}>
                        {sub?.code ? (
                          <button type="button" className="btn field-sm" onClick={() => toggleOne(k)}>
                            {open ? 'Hide code' : 'Show code'}
                          </button>
                        ) : null}
                      </td>
                    </tr>
                  );
                })
              )}
            </tbody>
          </table>
        </div>

        <DigitalReportFooter
          facultyName={meta.facultyName}
          timestamp={generatedAt}
          universityName={meta.institutionName}
        />
      </section>
    </div>
  );
}

async function fetchMetaForStudent(courseId: string, studentId: string): Promise<LabFileMeta> {
  const ds = await loadCourseData(courseId);
  const rep = computeReport(ds);
  const row = rep.rows.find((r) => r.student.id === studentId);
  if (!row) throw new Error('not_found');

  const [deptRes, facRes] = await Promise.all([
    supabase.from('departments').select('*').eq('id', ds.course.department_id).maybeSingle<Department>(),
    supabase.from('profiles').select('id, full_name').eq('id', ds.course.faculty_id).maybeSingle<Pick<Profile, 'id' | 'full_name'>>(),
  ]);
  const schoolRes = deptRes.data
    ? await supabase.from('schools').select('*').eq('id', deptRes.data.school_id).maybeSingle<School>()
    : { data: null };

  return {
    institutionName: ds.institution.name,
    schoolName: schoolRes.data?.name ?? 'School of Engineering and Technology',
    departmentName: deptRes.data?.name ?? 'Computer Science and Engineering',
    facultyName: facRes.data?.full_name ?? 'Course Faculty',
    course: ds.course,
    row,
  };
}

export function StudentLabFilePage() {
  const { profile } = useSession();
  const [searchParams, setSearchParams] = useSearchParams();
  const requestedCourseId = searchParams.get('course') ?? '';

  const { data, loading, error } = useLoad(async () => {
    const uid = profile?.id ?? '';
    const enrollments = await fetchAll<Enrollment>((from, to) =>
      supabase.from('enrollments').select('*').eq('student_id', uid).range(from, to),
    );
    const courseIds = Array.from(new Set(enrollments.map((e) => e.course_id)));
    if (courseIds.length === 0) {
      return { courses: [] as Course[], meta: null as LabFileMeta | null };
    }
    const courses = await fetchAll<Course>((from, to) =>
      supabase.from('courses').select('*').in('id', courseIds).range(from, to),
    );
    const targetId =
      courses.find((c) => c.id === requestedCourseId)?.id ?? courses[0]?.id ?? '';
    if (!targetId) return { courses, meta: null as LabFileMeta | null };
    const meta = await fetchMetaForStudent(targetId, uid);
    return { courses, meta };
  }, [profile?.id, requestedCourseId]);

  return (
    <StudentShell activeTab="file">
      {loading && !data ? <Loading label="Building your lab file…" /> : null}
      {error ? <ErrorNote message={error} /> : null}
      {data && !data.meta ? (
        <Empty title="No courses enrolled yet" body="Join a course using your batch class code on Home." />
      ) : null}
      {data && data.courses.length > 1 ? (
        <div className="no-print" style={{ maxWidth: 780, margin: '0 auto 14px' }}>
          <Card>
            <label className="field-label">
              Course lab file
              <select
                className="field field-sm"
                value={data.meta?.course.id ?? ''}
                onChange={(e) => setSearchParams({ course: e.target.value })}
              >
                {data.courses.map((c) => (
                  <option key={c.id} value={c.id}>
                    {c.code} · {c.title}
                  </option>
                ))}
              </select>
            </label>
          </Card>
        </div>
      ) : null}
      {data?.meta ? <LabFileDocument meta={data.meta} /> : null}
    </StudentShell>
  );
}

export function FacultyStudentLabFilePage() {
  const { courseId, studentId } = useParams<{ courseId: string; studentId: string }>();

  const { data, loading, error } = useLoad(async () => {
    if (!courseId || !studentId) throw new Error('not_found');
    return fetchMetaForStudent(courseId, studentId);
  }, [courseId, studentId]);

  return (
    <main style={{ minHeight: '100vh', padding: '24px 20px', background: 'var(--paper)' }}>
      {loading && !data ? <Loading label="Loading student lab file…" /> : null}
      {error ? <ErrorNote message={errorMessage(new Error(error))} /> : null}
      {data ? (
        <LabFileDocument
          meta={data}
          backLink={`/faculty/c/${data.course.id}/reports`}
          backLabel="Back to reports"
        />
      ) : null}
    </main>
  );
}
