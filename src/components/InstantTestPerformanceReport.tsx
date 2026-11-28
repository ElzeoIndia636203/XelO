import { Chip } from './ui';
import { PrintableReportFrame } from './DigitalReportFooter';
import { coAttainment } from '../lib/logic/attainment';
import { learners, mean } from '../lib/logic/stats';
import type { Course, CourseOutcome, Institution } from '../lib/types';

export interface ReportQuestionItem {
  id?: string;
  slot?: number;
  title: string;
  statement: string;
  difficulty: string;
  marks: number;
  co_code?: string;
  visible_marks?: number;
  hidden_marks?: number;
}

export interface ReportTestInfo {
  id: string;
  test_code: string;
  topic: string;
  total_marks: number;
  question_count: number;
  difficulty: string;
  co_code: string;
  visible_count: number;
  hidden_count: number;
  visible_marks: number;
  hidden_marks: number;
  pretest_count: number;
  pretest_difficulty: string;
  pretest_marks: number;
  posttest_count?: number;
  posttest_marks?: number;
  viva_marks: number;
  status: string;
  scheduled_at: string | null;
  conducted_at: string | null;
  questions?: ReportQuestionItem[];
}

export interface ReportAnswerItem {
  visible_marks_earned?: number;
  hidden_marks_earned?: number;
  marks_awarded?: number;
}

export interface ReportAttemptItem {
  id: string;
  student_id: string;
  prn: string;
  student_name: string;
  answers: Record<string, ReportAnswerItem>;
  pretest_score: number;
  coding_score: number;
  coding_override_score: number | null;
  viva_score: number;
  final_score: number;
  marks_approved: boolean;
  auto_submitted_breach?: boolean;
  cheating_marked?: boolean;
}

export function InstantTestPerformanceReport({
  universityName,
  departmentName,
  facultyName,
  course,
  test,
  outcomes,
  institution,
  attempts,
  conductedAt,
  generatedAt,
}: {
  universityName: string;
  departmentName: string;
  facultyName: string;
  course: Course;
  test: ReportTestInfo;
  outcomes: readonly CourseOutcome[];
  institution: Institution | null;
  attempts: readonly ReportAttemptItem[];
  conductedAt: string;
  generatedAt: string;
}) {
  const thresholdPct = institution?.attainment_threshold_pct ?? 60;
  const l1 = institution?.level_1_pct ?? 60;
  const l2 = institution?.level_2_pct ?? 70;
  const l3 = institution?.level_3_pct ?? 80;
  const maxMarks = Math.max(1, Number(test.total_marks || 1));

  const outcomeByCode = new Map(outcomes.map((o) => [o.code.toUpperCase(), o]));

  const questions = (test.questions ?? []).map((q, idx) => {
    const coCode = (q.co_code || test.co_code || '—').trim();
    const matchedCo = outcomeByCode.get(coCode.toUpperCase());
    return {
      index: idx + 1,
      unit: test.topic,
      title: q.title,
      statement: q.statement,
      coCode,
      difficulty: q.difficulty || test.difficulty,
      btl: matchedCo ? `L${matchedCo.btl}` : '—',
      marks: q.marks,
    };
  });

  const scoresPct = attempts.map((a) =>
    Math.round((Math.max(0, Number(a.final_score ?? 0)) * 100) / maxMarks),
  );
  const classMeanPct = Math.round(mean(scoresPct) * 10) / 10;

  const uniqueCoCodes = Array.from(
    new Set(
      questions
        .map((q) => q.coCode)
        .filter((c) => c && c !== '—')
        .concat(test.co_code && test.co_code !== '—' ? [test.co_code] : []),
    ),
  );

  const coCodesForReport = uniqueCoCodes.length > 0 ? uniqueCoCodes : ['Overall'];
  const coRows = coCodesForReport.map((code) => {
    const matchedCo = outcomeByCode.get(code.toUpperCase());
    const result = coAttainment(scoresPct, thresholdPct, l1, l2, l3);
    return {
      code,
      statement: matchedCo?.statement ?? '',
      btl: matchedCo ? `L${matchedCo.btl}` : '—',
      result,
      attained: result.level > 0,
    };
  });

  const learnerInput = attempts.map((a) => ({
    studentId: a.student_id,
    rollNo: a.prn,
    fullName: a.student_name,
    overallPct: Math.round((Math.max(0, Number(a.final_score ?? 0)) * 100) / maxMarks),
  }));
  const { slow, fast } = learners(learnerInput);

  const unapprovedCount = attempts.filter((a) => !a.marks_approved).length;
  const breachCount = attempts.filter((a) => a.cheating_marked || a.auto_submitted_breach).length;
  const notAttainedCos = coRows.filter((c) => !c.attained);

  const nextActions: string[] = [];
  if (attempts.length === 0) {
    nextActions.push('No student attempts recorded yet. Confirm attendance and activate the assessment to collect performance data.');
  } else {
    if (notAttainedCos.length > 0) {
      const codes = notAttainedCos.map((c) => c.code).join(', ');
      nextActions.push(
        `Conduct a targeted revision / remedial lab on "${test.topic}" (${codes}); attainment fell below the ${thresholdPct}% target.`,
      );
    }
    if (slow.length > 0) {
      const rolls = slow.slice(0, 6).map((s) => s.rollNo || s.fullName).join(', ');
      nextActions.push(
        `Schedule 1-on-1 mentoring and guided practice problems for ${slow.length} slow learner(s) (${rolls}${slow.length > 6 ? '…' : ''}).`,
      );
    }
    if (fast.length > 0) {
      const rolls = fast.slice(0, 6).map((f) => f.rollNo || f.fullName).join(', ');
      nextActions.push(
        `Assign advanced extension problems or peer-mentoring tasks to ${fast.length} fast learner(s) (${rolls}${fast.length > 6 ? '…' : ''}).`,
      );
    }
    if (breachCount > 0) {
      nextActions.push(
        `Review ${breachCount} proctoring / misconduct flagged attempt(s) and document disciplinary remarks before finalizing.`,
      );
    }
    if (unapprovedCount > 0) {
      nextActions.push(
        `Verify coding & viva scores for ${unapprovedCount} pending student(s) and finalize marks to lock records for NBA/NAAC.`,
      );
    }
    if (nextActions.length === 0) {
      nextActions.push(
        `All mapped COs attained and all marks finalized. Archive this report in the course file and proceed to the next lab unit.`,
      );
    }
  }

  const rubricParts: string[] = [];
  if (test.pretest_count > 0 || test.pretest_marks > 0) {
    rubricParts.push(`Pre-test: ${test.pretest_marks}m (${test.pretest_count} MCQs)`);
  }
  rubricParts.push(
    `Coding: ${test.question_count} Q × (${test.visible_marks}m visible [${test.visible_count} cases] + ${test.hidden_marks}m hidden [${test.hidden_count} cases])`,
  );
  if ((test.posttest_count ?? 0) > 0 || (test.posttest_marks ?? 0) > 0) {
    rubricParts.push(`Post-test: ${test.posttest_marks ?? 0}m (${test.posttest_count ?? 0} MCQs)`);
  }
  if (test.viva_marks > 0) {
    rubricParts.push(`Viva: ${test.viva_marks}m`);
  }

  return (
    <PrintableReportFrame
      facultyName={facultyName}
      timestamp={generatedAt}
      universityName={universityName}
      officialTitle="Official Assessment Performance & Attainment Report"
      officialSubtitle={`Department of ${departmentName} · ${course.code} ${course.title}`}
    >
      <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
        {/* Official Title Banner (visible on screen too) */}
        <div
          className="no-print"
          style={{
            textAlign: 'center',
            padding: '10px 12px',
            borderRadius: 6,
            border: '1px solid var(--border)',
            background: 'var(--bg-subtle)',
          }}
        >
          <div style={{ fontSize: 11, textTransform: 'uppercase', letterSpacing: 1.2, color: 'var(--muted)' }}>
            {universityName}
          </div>
          <div style={{ fontSize: 13, fontWeight: 600, marginTop: 2 }}>
            Department of {departmentName}
          </div>
        </div>

        {/* 1. Details of Exam */}
        <section style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
          <h3 style={{ fontSize: 13.5, fontWeight: 700, margin: 0 }}>1. Details of Exam</h3>
          <div style={{ overflowX: 'auto' }}>
            <table>
            <tbody>
              <tr>
                <td style={{ width: '22%', fontWeight: 600 }}>Course Name &amp; Code</td>
                <td style={{ width: '38%' }}>{course.code} · {course.title}</td>
                <td style={{ width: '18%', fontWeight: 600 }}>Date of Exam</td>
                <td style={{ width: '22%' }}>{conductedAt}</td>
              </tr>
              <tr>
                <td style={{ fontWeight: 600 }}>Unit / Topic</td>
                <td>{test.topic} (Code: <span className="mono">{test.test_code}</span>)</td>
                <td style={{ fontWeight: 600 }}>Total Marks</td>
                <td className="mono" style={{ fontWeight: 700 }}>{test.total_marks}</td>
              </tr>
              <tr>
                <td style={{ fontWeight: 600 }}>Rubrics</td>
                <td colSpan={3}>{rubricParts.join(' · ')}</td>
              </tr>
            </tbody>
            </table>
          </div>
        </section>

        {/* 2. Question Paper */}
        <section style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
          <h3 style={{ fontSize: 13.5, fontWeight: 700, margin: 0 }}>
            2. Question Paper (Mapped with Unit, CO, Difficulty, BTL Level &amp; Marks)
          </h3>
          {questions.length === 0 ? (
            <div style={{ fontSize: 12.5, color: 'var(--muted)' }}>No question paper items recorded.</div>
          ) : (
            <div style={{ overflowX: 'auto' }}>
              <table>
              <thead>
                <tr>
                  <th style={{ width: 38 }}>Q#</th>
                  <th>Unit / Topic</th>
                  <th>Question</th>
                  <th style={{ width: 58 }}>CO</th>
                  <th style={{ width: 72 }}>Difficulty</th>
                  <th style={{ width: 54 }}>BTL</th>
                  <th style={{ width: 56, textAlign: 'right' }}>Marks</th>
                </tr>
              </thead>
              <tbody>
                {questions.map((q) => (
                  <tr key={q.index}>
                    <td className="mono">Q{q.index}</td>
                    <td>{q.unit}</td>
                    <td>
                      <div style={{ fontWeight: 600 }}>{q.title}</div>
                      <div style={{ fontSize: 11.5, color: 'var(--muted)', whiteSpace: 'pre-wrap', marginTop: 2 }}>
                        {q.statement}
                      </div>
                    </td>
                    <td className="mono">{q.coCode}</td>
                    <td style={{ textTransform: 'capitalize' }}>{q.difficulty}</td>
                    <td className="mono">{q.btl}</td>
                    <td className="mono" style={{ textAlign: 'right', fontWeight: 600 }}>{q.marks}</td>
                  </tr>
                ))}
              </tbody>
              </table>
            </div>
          )}
        </section>

        {/* 3. Mark Sheet */}
        <section style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline' }}>
            <h3 style={{ fontSize: 13.5, fontWeight: 700, margin: 0 }}>3. Mark Sheet</h3>
            <span className="mono" style={{ fontSize: 11.5, color: 'var(--muted)' }}>
              Students: {attempts.length} · Class Mean: {classMeanPct}%
            </span>
          </div>
          <div style={{ overflowX: 'auto' }}>
            <table>
            <thead>
              <tr>
                <th>Roll / PRN</th>
                <th>Student name</th>
                <th>Pre-test ({test.pretest_marks})</th>
                <th>Visible</th>
                <th>Hidden</th>
                <th>Coding final</th>
                <th>Viva ({test.viva_marks})</th>
                <th>Total ({test.total_marks})</th>
                <th>%</th>
              </tr>
            </thead>
            <tbody>
              {attempts.length === 0 ? (
                <tr>
                  <td colSpan={9} style={{ textAlign: 'center', color: 'var(--muted)' }}>
                    No student attempts recorded.
                  </td>
                </tr>
              ) : (
                attempts.map((r) => {
                  const ansList = Object.values(r.answers ?? {});
                  const visSum = ansList.reduce((s, x) => s + Number(x.visible_marks_earned ?? 0), 0);
                  const hidSum = ansList.reduce((s, x) => s + Number(x.hidden_marks_earned ?? 0), 0);
                  const effCoding = r.coding_override_score ?? r.coding_score;
                  const pct = Math.round((Math.max(0, Number(r.final_score ?? 0)) * 100) / maxMarks);
                  return (
                    <tr key={r.id}>
                      <td className="mono">{r.prn}</td>
                      <td>
                        {r.student_name}
                        {r.cheating_marked ? ' (Terminated - Cheating)' : ''}
                      </td>
                      <td className="mono">{r.pretest_score}</td>
                      <td className="mono">{visSum}</td>
                      <td className="mono">{hidSum}</td>
                      <td className="mono">{effCoding}</td>
                      <td className="mono">{r.viva_score}</td>
                      <td className="mono" style={{ fontWeight: 700 }}>{r.final_score}</td>
                      <td className="mono">{pct}%</td>
                    </tr>
                  );
                })
              )}
            </tbody>
            </table>
          </div>
        </section>

        {/* 4. CO Attainment Report */}
        <section style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
          <h3 style={{ fontSize: 13.5, fontWeight: 700, margin: 0 }}>4. CO Attainment Report</h3>
          <div style={{ overflowX: 'auto' }}>
            <table>
            <thead>
              <tr>
                <th>CO</th>
                <th>BTL</th>
                <th style={{ textAlign: 'right' }}>Target</th>
                <th style={{ textAlign: 'right' }}>Attained / Total</th>
                <th style={{ textAlign: 'right' }}>Attainment %</th>
                <th style={{ textAlign: 'right' }}>Level</th>
                <th>Status</th>
              </tr>
            </thead>
            <tbody>
              {coRows.map((c) => (
                <tr key={c.code}>
                  <td className="mono" style={{ fontWeight: 600 }}>{c.code}</td>
                  <td className="mono">{c.btl}</td>
                  <td className="mono" style={{ textAlign: 'right' }}>≥ {thresholdPct}%</td>
                  <td className="mono" style={{ textAlign: 'right' }}>
                    {c.result.attainedCount} / {c.result.totalCount}
                  </td>
                  <td className="mono" style={{ textAlign: 'right' }}>{c.result.pct}%</td>
                  <td className="mono" style={{ textAlign: 'right' }}>L{c.result.level}</td>
                  <td>
                    <Chip tone={c.attained ? 'good' : 'bad'}>
                      {c.attained ? 'Attained' : 'Not attained'}
                    </Chip>
                  </td>
                </tr>
              ))}
            </tbody>
            </table>
          </div>
        </section>

        {/* 5. Slow Learners & Fast Learners */}
        <section style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
          <h3 style={{ fontSize: 13.5, fontWeight: 700, margin: 0 }}>5. Slow Learners &amp; Fast Learners</h3>
          <div className="grid-2" style={{ alignItems: 'start' }}>
            <div style={{ border: '1px solid var(--border)', borderRadius: 6, padding: 10 }}>
              <div style={{ fontWeight: 600, fontSize: 12.5, marginBottom: 6 }}>
                Slow Learners ({slow.length})
              </div>
              {slow.length === 0 ? (
                <div style={{ fontSize: 12, color: 'var(--muted)' }}>None identified</div>
              ) : (
                <ul style={{ margin: 0, paddingLeft: 16, fontSize: 12 }}>
                  {slow.map((s) => (
                    <li key={s.studentId}>
                      <span className="mono">{s.rollNo}</span> · {s.fullName} ({s.overallPct}% · {s.reason})
                    </li>
                  ))}
                </ul>
              )}
            </div>
            <div style={{ border: '1px solid var(--border)', borderRadius: 6, padding: 10 }}>
              <div style={{ fontWeight: 600, fontSize: 12.5, marginBottom: 6 }}>
                Fast Learners ({fast.length})
              </div>
              {fast.length === 0 ? (
                <div style={{ fontSize: 12, color: 'var(--muted)' }}>None identified</div>
              ) : (
                <ul style={{ margin: 0, paddingLeft: 16, fontSize: 12 }}>
                  {fast.map((f) => (
                    <li key={f.studentId}>
                      <span className="mono">{f.rollNo}</span> · {f.fullName} ({f.overallPct}% · {f.reason})
                    </li>
                  ))}
                </ul>
              )}
            </div>
          </div>
        </section>

        {/* 6. Suggested Next Actions */}
        <section style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
          <h3 style={{ fontSize: 13.5, fontWeight: 700, margin: 0 }}>6. Suggested Next Actions</h3>
          <div style={{ border: '1px solid var(--border)', borderRadius: 6, padding: '10px 12px', background: 'var(--bg-subtle)' }}>
            <ol style={{ margin: 0, paddingLeft: 18, fontSize: 12.5, lineHeight: 1.55 }}>
              {nextActions.map((act, idx) => (
                <li key={idx}>{act}</li>
              ))}
            </ol>
          </div>
        </section>
      </div>
    </PrintableReportFrame>
  );
}
