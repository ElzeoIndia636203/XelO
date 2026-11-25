import { Link, useParams } from 'react-router-dom';
import { Card, Chip, Elzeo, ErrorNote, Loading, PageHead, Wordmark } from '../../components/ui';
import { errorMessage } from '../../lib/errors';
import { useLoad } from '../../lib/hooks';
import { rpc } from '../../lib/supabase';
import type { VerifyLabFileResult } from '../../lib/types';

const FINAL_STAGE_LABELS = new Map<string, string>([
  ['coe_accepted', 'CoE accepted'],
  ['hod_approved', 'HOD approved'],
  ['sent', 'Submitted to HOD'],
  ['returned', 'Returned'],
  ['none', 'In progress'],
]);

export function PublicVerifyPage() {
  const { courseId, studentId } = useParams<{ courseId: string; studentId: string }>();

  const { data, loading, error } = useLoad(async () => {
    if (!courseId || !studentId) throw new Error('not_found');
    return rpc<VerifyLabFileResult>('verify_lab_file', {
      p_course_id: courseId,
      p_student_id: studentId,
    });
  }, [courseId, studentId]);

  return (
    <div style={{ minHeight: '100vh', display: 'flex', flexDirection: 'column', background: 'var(--paper)' }}>
      <header
        className="dark-surface"
        style={{
          minHeight: 54,
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'space-between',
          padding: '8px 20px',
          background: 'var(--rail)',
          color: '#E8E6DF',
        }}
      >
        <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
          <Wordmark dark />
          <Elzeo dark />
        </div>
        <Link className="btn field-sm" to="/login" style={{ background: '#2C2B28', color: '#FFFFFF', borderColor: '#3E3D39' }}>
          Sign in
        </Link>
      </header>

      <main style={{ flex: 1, maxWidth: 680, width: '100%', margin: '32px auto', padding: '0 16px', display: 'flex', flexDirection: 'column', gap: 16 }}>
        <PageHead
          kicker="LAB FILE VERIFICATION"
          title="Verified Laboratory Record"
          lead="Official summary fetched directly from institutional database records."
        />

        {loading && !data ? <Loading label="Verifying record…" /> : null}
        {error ? <ErrorNote message={errorMessage(new Error(error))} /> : null}

        {data && !data.found ? (
          <Card title="Record not found">
            <p style={{ fontSize: 13, color: 'var(--muted)', margin: 0 }}>
              No active enrolment record matches this course and student link.
            </p>
          </Card>
        ) : null}

        {data && data.found ? (
          <Card
            title={`${data.course_code} · ${data.course_title}`}
            actions={<Chip tone="good">Verified record</Chip>}
          >
            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(180px, 1fr))', gap: 14 }}>
              <div>
                <div style={{ fontSize: 11, color: 'var(--muted)' }}>Institution</div>
                <div style={{ fontWeight: 600 }}>{data.institution_name}</div>
              </div>
              <div>
                <div style={{ fontSize: 11, color: 'var(--muted)' }}>Student</div>
                <div style={{ fontWeight: 600 }}>{data.student_name}</div>
              </div>
              <div>
                <div style={{ fontSize: 11, color: 'var(--muted)' }}>Roll number</div>
                <div className="mono" style={{ fontWeight: 600 }}>{data.roll_no || '—'}</div>
              </div>
              <div>
                <div style={{ fontSize: 11, color: 'var(--muted)' }}>Semester · Year</div>
                <div>{data.semester} · {data.academic_year}</div>
              </div>
              <div>
                <div style={{ fontSize: 11, color: 'var(--muted)' }}>Internal marks</div>
                <div className="mono" style={{ fontSize: 20, fontWeight: 600 }}>
                  {data.internal_out_of_100 ?? 0} / 100
                </div>
              </div>
              <div>
                <div style={{ fontSize: 11, color: 'var(--muted)' }}>Attendance</div>
                <div className="mono" style={{ fontSize: 20, fontWeight: 600 }}>
                  {data.attendance_pct ?? 0}%
                </div>
              </div>
              <div>
                <div style={{ fontSize: 11, color: 'var(--muted)' }}>Verification ID</div>
                <div className="mono">{data.verification_code}</div>
              </div>
              <div>
                <div style={{ fontSize: 11, color: 'var(--muted)' }}>Approval stage</div>
                <Chip tone={data.final_status === 'coe_accepted' ? 'good' : 'neutral'}>
                  {data.final_status
                    ? (FINAL_STAGE_LABELS.get(data.final_status) ?? data.final_status)
                    : 'In progress'}
                </Chip>
              </div>
            </div>
          </Card>
        ) : null}
      </main>

      <footer
        style={{
          borderTop: '1px solid var(--border)',
          padding: '14px 20px',
          display: 'flex',
          justifyContent: 'center',
          alignItems: 'center',
          gap: 8,
          fontSize: 11,
          color: 'var(--muted)',
        }}
      >
        <Wordmark />
        <span>· designed and maintained by</span>
        <Elzeo />
        <span>Elzeo Future Technologies Pvt Ltd, India</span>
      </footer>
    </div>
  );
}
export default PublicVerifyPage;
