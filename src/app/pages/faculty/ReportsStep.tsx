import { useState } from 'react';
import { Link } from 'react-router-dom';
import { Banner, Card, Chip, Elzeo, Empty, Kpis, Loading, Seg, Wordmark } from '../../../components/ui';
import { PrintableReportFrame } from '../../../components/DigitalReportFooter';
import { computeReport, loadCourseData } from '../../../lib/api/report';
import { errorMessage } from '../../../lib/errors';
import { formatDateTimeIst, formatTimeIst } from '../../../lib/format';
import { useLoad } from '../../../lib/hooks';
import { histogram10, mean, normalPdf, sd, toCsv, downloadTextFile } from '../../../lib/logic/stats';
import { buildZip } from '../../../lib/logic/zip';
import { useSession } from '../../../lib/session';
import { fn, rpc, supabase } from '../../../lib/supabase';
import type { Course } from '../../../lib/types';

type ReportsTabId = 'file' | 'internal' | 'students' | 'final';

export function ReportsStep({
  course,
  onNotify,
  onRefresh,
}: {
  course: Course;
  onNotify: (msg: string, ok: boolean) => void;
  onRefresh: () => void;
}) {
  const { profile } = useSession();
  const { data: dataset, loading, error, reload } = useLoad(
    () => loadCourseData(course.id),
    [course.id],
  );

  const [tab, setTab] = useState<ReportsTabId>('file');
  const [selectedCoKey, setSelectedCoKey] = useState<string>('overall');
  const [selectedStudentId, setSelectedStudentId] = useState<string>('');
  const [bosText, setBosText] = useState<string | null>(null);
  const [intSummaryText, setIntSummaryText] = useState<string | null>(null);
  const [overSummaryText, setOverSummaryText] = useState<string | null>(null);
  const [manualFlagStudentId, setManualFlagStudentId] = useState<string>('');
  const [manualFlagKind, setManualFlagKind] = useState<'slow' | 'fast'>('slow');
  const [manualFlagNote, setManualFlagNote] = useState('');
  const [busyKey, setBusyKey] = useState<string | null>(null);

  if (loading && !dataset) {
    return <Loading label="Computing accreditation report…" />;
  }
  if (error || !dataset) {
    return <Banner tone="err">{errorMessage(new Error(error ?? 'not_found'))}</Banner>;
  }

  const currentDataset = dataset;
  const report = computeReport(currentDataset);
  const activeStudent =
    report.rows.find((r) => r.student.id === selectedStudentId) ?? report.rows[0] ?? null;
  const activeFlagTargetId = manualFlagStudentId || activeStudent?.student.id || '';

  const bosVal = bosText ?? currentDataset.notes?.bos_suggestions ?? '';
  const intSumVal = intSummaryText ?? currentDataset.notes?.internal_summary ?? '';
  const overSumVal = overSummaryText ?? currentDataset.notes?.overall_summary ?? '';

  // Histogram + bell curve data for selected CO or Overall
  const selectedScores =
    selectedCoKey === 'overall'
      ? report.rows.map((r) => r.overallPct)
      : report.rows.map((r) => r.coOverall.get(selectedCoKey) ?? 0);
  const distMu = Math.round(mean(selectedScores) * 10) / 10;
  const distSd = Math.round(sd(selectedScores) * 10) / 10;
  const bins = histogram10(selectedScores);
  const pdfPoints = Array.from({ length: 51 }, (_, k) => {
    const x = k * 2;
    return { x, y: selectedScores.length * 10 * normalPdf(x, distMu, Math.max(distSd, 1)) };
  });
  const maxChartY = Math.max(1, ...bins, ...pdfPoints.map((p) => p.y));
  const curvePath = pdfPoints
    .map((p, k) => `${k === 0 ? 'M' : 'L'}${p.x} ${(100 - (100 * p.y) / maxChartY).toFixed(2)}`)
    .join(' ');

  function exportMarkListCsv() {
    const headers = ['Roll', 'Name', 'Batch', 'Attendance %', 'Internal /100', 'Overall %', 'Last submitted'];
    const csvRows = report.rows.map((r) => [
      r.student.roll_no ?? '',
      r.student.full_name,
      r.batch?.name ?? '',
      r.attendancePct,
      r.internalPct,
      r.overallPct,
      r.lastSubmittedAt ? formatTimeIst(r.lastSubmittedAt) : '',
    ]);
    downloadTextFile(`${course.code}-mark-list.csv`, toCsv(headers, csvRows, true));
  }

  function exportActualLogCsv() {
    const headers = ['Session', 'Topic', 'Planned date', 'Batches run', 'Status', 'Remarks'];
    const csvRows = report.actualLogRows.map((lg) => [
      `S${lg.sessionNumber}`,
      lg.topic,
      lg.plannedDate ?? '—',
      lg.batchesRun,
      lg.status,
      lg.remark,
    ]);
    downloadTextFile(`${course.code}-actual-log.csv`, toCsv(headers, csvRows, true));
  }

  function exportInternalSheetCsv() {
    const headers = [
      'Roll',
      'Name',
      'Attendance %',
      'Internal /100',
      ...currentDataset.outcomes.map((co) => `${co.code} %`),
    ];
    const csvRows = report.rows.map((r) => [
      r.student.roll_no ?? '',
      r.student.full_name,
      r.attendancePct,
      r.internalPct,
      ...currentDataset.outcomes.map((co) => r.coInternal.get(co.id) ?? 0),
    ]);
    downloadTextFile(`${course.code}-internal-sheet.csv`, toCsv(headers, csvRows, true));
  }

  function downloadAllZip() {
    const entries = report.rows.map((r) => {
      const roll = r.student.roll_no || r.student.id.slice(0, 6);
      const html = `<!doctype html><html><meta charset="utf-8"><title>${course.code} ${roll}</title><body><h1>${course.code} · ${course.title}</h1><p>${r.student.full_name} (${roll})</p><p>Internal: ${r.internalPct}/100 · Attendance: ${r.attendancePct}%</p></body></html>`;
      return { name: `${roll}-${r.student.full_name.replace(/[^a-zA-Z0-9]+/g, '_')}.html`, content: html };
    });
    const zipBytes = buildZip(entries);
    const blob = new Blob([zipBytes.buffer as ArrayBuffer], { type: 'application/zip' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `${course.code}-lab-files.zip`;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    window.setTimeout(() => URL.revokeObjectURL(url), 1000);
    onNotify(`Downloaded ${entries.length} student lab file(s) as ZIP.`, true);
  }

  async function saveNotes() {
    setBusyKey('notes');
    try {
      await rpc('save_course_notes', {
        p_course_id: course.id,
        p_bos_suggestions: bosVal,
        p_internal_summary: intSumVal,
        p_overall_summary: overSumVal,
      });
      onNotify('Saved course file summaries and BoS suggestions.', true);
      reload();
    } catch (err) {
      onNotify(errorMessage(err), false);
    } finally {
      setBusyKey(null);
    }
  }

  async function draftNarrativesWithAi() {
    setBusyKey('ai-narratives');
    try {
      const res = await fn<{
        draft: { internal_summary: string; overall_summary: string; bos_suggestions: string };
      }>('ai-generate', {
        kind: 'report_narrative',
        course_id: course.id,
        metrics: {
          students: report.rows.length,
          conducted_sessions: report.conductedSessions.length,
          internal_mean: report.internalMean,
          below_40: report.below40Count,
          overall_pct: report.overallAttainment.pct,
          cos: report.coInternal.map((c) => ({ code: c.co.code, pct: c.internal.pct, mean: c.meanPct })),
        },
      });
      setIntSummaryText(res.draft.internal_summary);
      setOverSummaryText(res.draft.overall_summary);
      setBosText(res.draft.bos_suggestions);
      onNotify('Drafted report summaries with Assist. Review and save below.', true);
      onRefresh();
    } catch (err) {
      onNotify(errorMessage(err), false);
    } finally {
      setBusyKey(null);
    }
  }

  async function saveSnapshot() {
    setBusyKey('snapshot');
    try {
      const coInternalObj = Object.fromEntries(
        report.coInternal.map((c) => [c.co.code, c.internal.pct]),
      );
      const coOverallObj = Object.fromEntries(
        report.coOverall.map((c) => [c.co.code, c.overall.pct]),
      );
      await rpc('save_course_snapshot', {
        p_course_id: course.id,
        p_students: report.rows.length,
        p_internal_mean: report.internalMean,
        p_below_40: report.below40Count,
        p_co_internal: coInternalObj,
        p_co_overall: coOverallObj,
        p_overall_pct: report.overallAttainment.pct,
      });
      onNotify('Saved course attainment snapshot for oversight dashboards.', true);
    } catch (err) {
      onNotify(errorMessage(err), false);
    } finally {
      setBusyKey(null);
    }
  }

  async function addManualFlag() {
    if (!activeFlagTargetId) return;
    setBusyKey('flag');
    try {
      await rpc('flag_student', {
        p_course_id: course.id,
        p_student_id: activeFlagTargetId,
        p_kind: manualFlagKind,
        p_note: manualFlagNote.trim() || `Manual ${manualFlagKind} learner tag`,
      });
      setManualFlagNote('');
      onNotify('Updated manual learner flag.', true);
      reload();
    } catch (err) {
      onNotify(errorMessage(err), false);
    } finally {
      setBusyKey(null);
    }
  }

  async function removeFlag(flagId: string) {
    setBusyKey(`rm-flag-${flagId}`);
    try {
      const { error: delErr } = await supabase.from('course_flags').delete().eq('id', flagId);
      if (delErr) throw new Error(delErr.message);
      reload();
    } catch (err) {
      onNotify(errorMessage(err), false);
    } finally {
      setBusyKey(null);
    }
  }

  async function submitFinalMarks() {
    setBusyKey('final');
    try {
      await rpc('submit_final_marks', { p_course_id: course.id });
      onNotify('Final marks submitted to HOD for verification.', true);
      reload();
      onRefresh();
    } catch (err) {
      onNotify(errorMessage(err), false);
    } finally {
      setBusyKey(null);
    }
  }

  const finalApprovals = dataset.approvals.filter((a) => a.object_type === 'final_marks');
  const latestFinalRemark = finalApprovals[0]?.remark ?? null;
  const studentNameMap = new Map(dataset.students.map((s) => [s.id, s]));
  const reportGeneratedAt = formatDateTimeIst(new Date().toISOString());
  const reportFacultyName = profile?.full_name ?? 'Course Faculty';
  const reportTitleByTab: Record<ReportsTabId, string> = {
    file: 'Official Course File (NBA / NAAC)',
    internal: 'Official Internal Attainment Report',
    students: 'Official Student Lab Files Roster',
    final: 'Official Final Marks Submission Report',
  };

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
      <div className="no-print">
        <Seg
          label="Reports sections"
          options={[
            { value: 'file', label: 'Course file' },
            { value: 'internal', label: 'Internal report' },
            { value: 'students', label: 'Student lab files' },
            { value: 'final', label: 'Final marks' },
          ]}
          value={tab}
          onChange={(val) => setTab(val as ReportsTabId)}
        />
      </div>

      <PrintableReportFrame
        facultyName={reportFacultyName}
        timestamp={reportGeneratedAt}
        universityName={currentDataset.institution.name}
        officialTitle={reportTitleByTab[tab]}
        officialSubtitle={`${course.code} · ${course.title} · Semester ${course.semester} · ${course.academic_year}`}
      >

      {tab === 'file' ? (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
          <Card
            title="Course file (14 NBA/NAAC sections)"
            actions={
              <div className="no-print" style={{ display: 'flex', flexWrap: 'wrap', gap: 8 }}>
                <button type="button" className="btn field-sm" onClick={exportMarkListCsv}>
                  Mark list (CSV)
                </button>
                <button type="button" className="btn field-sm" onClick={exportActualLogCsv}>
                  Actual log (CSV)
                </button>
                <button type="button" className="btn btn-primary field-sm" onClick={() => window.print()}>
                  Print / save as PDF
                </button>
              </div>
            }
            flush
          >
            <table>
              <thead>
                <tr>
                  <th>#</th>
                  <th>Course file section</th>
                  <th>Status</th>
                </tr>
              </thead>
              <tbody>
                {report.courseFileSections.map((fs) => (
                  <tr key={fs.n}>
                    <td className="mono" style={{ color: 'var(--muted)' }}>
                      {fs.n}
                    </td>
                    <td>{fs.title}</td>
                    <td>
                      <Chip tone={fs.ready ? 'good' : 'neutral'}>{fs.status}</Chip>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </Card>

          <Card title="Actual log of session plan" actions={<span style={{ fontSize: 12, color: 'var(--muted)' }}>Planned vs conducted</span>} flush>
            <div style={{ overflowX: 'auto' }}>
              <table>
                <thead>
                  <tr>
                    <th>Session</th>
                    <th>Topic</th>
                    <th>Planned date</th>
                    <th style={{ textAlign: 'right' }}>Batches run</th>
                    <th>Status</th>
                    <th>Remarks</th>
                  </tr>
                </thead>
                <tbody>
                  {report.actualLogRows.length === 0 ? (
                    <tr>
                      <td colSpan={6} style={{ textAlign: 'center', color: 'var(--muted)', padding: 14 }}>
                        No sessions planned yet.
                      </td>
                    </tr>
                  ) : (
                    report.actualLogRows.map((lg) => (
                      <tr key={lg.sessionNumber}>
                        <td className="mono">S{lg.sessionNumber}</td>
                        <td>{lg.topic}</td>
                        <td className="mono" style={{ fontSize: 12 }}>{lg.plannedDate ?? '—'}</td>
                        <td className="mono" style={{ textAlign: 'right' }}>{lg.batchesRun}</td>
                        <td>
                          <Chip tone={lg.status === 'As planned' ? 'good' : lg.status === 'Scheduled' ? 'neutral' : 'warn'}>
                            {lg.status}
                          </Chip>
                        </td>
                        <td style={{ fontSize: 12, color: 'var(--muted)' }}>{lg.remark}</td>
                      </tr>
                    ))
                  )}
                </tbody>
              </table>
            </div>
          </Card>

          <Card
            title="Course file narratives & BoS suggestions (Sections 9, 10 & 14)"
            actions={
              <button
                type="button"
                className="btn field-sm no-print"
                disabled={busyKey === 'ai-narratives'}
                onClick={() => void draftNarrativesWithAi()}
              >
                {busyKey === 'ai-narratives' ? 'Drafting…' : 'Draft summaries with Assist'}
              </button>
            }
          >
            <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
              <label className="field-label">
                Internal summary (Section 9)
                <textarea
                  className="field"
                  rows={2}
                  style={{ height: 'auto', padding: 8 }}
                  value={intSumVal}
                  onChange={(e) => setIntSummaryText(e.target.value)}
                />
              </label>
              <label className="field-label">
                Suggestions for next BoS (Section 10)
                <textarea
                  className="field"
                  rows={2}
                  style={{ height: 'auto', padding: 8 }}
                  value={bosVal}
                  onChange={(e) => setBosText(e.target.value)}
                />
              </label>
              <label className="field-label">
                Overall summary (Section 14)
                <textarea
                  className="field"
                  rows={2}
                  style={{ height: 'auto', padding: 8 }}
                  value={overSumVal}
                  onChange={(e) => setOverSummaryText(e.target.value)}
                />
              </label>
              <div className="no-print">
                <button
                  type="button"
                  className="btn btn-primary field-sm"
                  disabled={busyKey === 'notes'}
                  onClick={() => void saveNotes()}
                >
                  {busyKey === 'notes' ? 'Saving…' : 'Save notes'}
                </button>
              </div>
            </div>
          </Card>

          <div
            style={{
              display: 'flex',
              justifyContent: 'center',
              alignItems: 'center',
              gap: 8,
              padding: '8px 0',
              fontSize: 11,
              color: 'var(--muted)',
            }}
          >
            <Wordmark />
            <span>· course file prepared with</span>
            <Elzeo />
          </div>
        </div>
      ) : null}

      {tab === 'internal' ? (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
          <Kpis
            items={[
              { label: 'Overall attainment', value: `${report.overallAttainment.pct}%` },
              {
                label: 'COs attained',
                value: `${report.coInternal.filter((c) => c.attained).length}/${report.coInternal.length}`,
              },
              { label: 'Class mean', value: `${report.internalMean}%` },
              { label: 'Slow learners', value: report.slowLearners.length + report.manualSlow.length },
              { label: 'Fast learners', value: report.fastLearners.length + report.manualFast.length },
            ]}
          />

          <div className="grid-2" style={{ alignItems: 'start' }}>
            <Card title="CO attainment" flush>
              <div style={{ overflowX: 'auto' }}>
                <table>
                  <thead>
                    <tr>
                      <th>CO</th>
                      <th style={{ textAlign: 'right' }}>≥ {dataset.institution.attainment_threshold_pct}%</th>
                      <th style={{ textAlign: 'right' }}>Mean</th>
                      <th style={{ textAlign: 'right' }}>Level</th>
                      <th>Result</th>
                    </tr>
                  </thead>
                  <tbody>
                    {report.coInternal.map((c) => {
                      const sel = selectedCoKey === c.co.id;
                      return (
                        <tr key={c.co.id}>
                          <td>
                            <button
                              type="button"
                              className={`btn field-sm ${sel ? 'btn-primary' : ''}`}
                              onClick={() => setSelectedCoKey(c.co.id)}
                            >
                              {c.co.code}
                            </button>
                          </td>
                          <td className="mono" style={{ textAlign: 'right' }}>{c.internal.pct}%</td>
                          <td className="mono" style={{ textAlign: 'right' }}>{c.meanPct}%</td>
                          <td className="mono" style={{ textAlign: 'right' }}>L{c.internal.level}</td>
                          <td>
                            <Chip tone={c.attained ? 'good' : 'bad'}>
                              {c.attained ? 'Attained' : 'Not attained'}
                            </Chip>
                          </td>
                        </tr>
                      );
                    })}
                    <tr>
                      <td>
                        <button
                          type="button"
                          className={`btn field-sm ${selectedCoKey === 'overall' ? 'btn-primary' : ''}`}
                          onClick={() => setSelectedCoKey('overall')}
                        >
                          Overall
                        </button>
                      </td>
                      <td className="mono" style={{ textAlign: 'right' }}>{report.overallAttainment.pct}%</td>
                      <td className="mono" style={{ textAlign: 'right' }}>{report.internalMean}%</td>
                      <td className="mono" style={{ textAlign: 'right' }}>L{report.overallAttainment.level}</td>
                      <td>
                        <Chip tone={report.overallAttainment.level > 0 ? 'good' : 'bad'}>
                          {report.overallAttainment.level > 0 ? 'Attained' : 'Not attained'}
                        </Chip>
                      </td>
                    </tr>
                  </tbody>
                </table>
              </div>
            </Card>

            <Card
              title={`${selectedCoKey === 'overall' ? 'Overall' : dataset.outcomes.find((o) => o.id === selectedCoKey)?.code ?? 'CO'} distribution`}
              actions={
                <span className="mono" style={{ fontSize: 12, color: 'var(--muted)' }}>
                  mean {distMu}% · sd {distSd}
                </span>
              }
            >
              <div style={{ position: 'relative', height: 170 }}>
                <div
                  role="img"
                  aria-label="Histogram with bell curve"
                  style={{
                    position: 'absolute',
                    inset: 0,
                    display: 'flex',
                    alignItems: 'flex-end',
                    gap: 4,
                    borderBottom: '1px solid var(--border)',
                  }}
                >
                  {bins.map((count, b) => (
                    <div
                      key={b}
                      title={`${b * 10}–${b * 10 + 9}%: ${count}`}
                      style={{
                        flex: 1,
                        height: count === 0 ? '2px' : `${Math.max(8, Math.round((count / maxChartY) * 100))}%`,
                        borderRadius: '3px 3px 0 0',
                        background:
                          count === 0
                            ? 'var(--border-soft)'
                            : b < 4
                              ? 'var(--assist)'
                              : 'var(--teal)',
                      }}
                    />
                  ))}
                </div>
                <svg
                  viewBox="0 0 100 100"
                  preserveAspectRatio="none"
                  aria-hidden="true"
                  style={{ position: 'absolute', inset: 0, width: '100%', height: '100%', overflow: 'visible' }}
                >
                  <path d={curvePath} fill="none" stroke="#141413" strokeWidth="1.5" vectorEffect="non-scaling-stroke" />
                </svg>
              </div>
              <div className="mono" style={{ display: 'flex', justifyContent: 'space-between', fontSize: 11, color: 'var(--muted)', marginTop: 8 }}>
                <span>0</span>
                <span>40 slow</span>
                <span>{dataset.institution.attainment_threshold_pct} target</span>
                <span>80 fast</span>
                <span>100</span>
              </div>
            </Card>
          </div>

          <div className="grid-2" style={{ alignItems: 'start' }}>
            <Card title="Gaps & insights">
              <div style={{ display: 'flex', flexDirection: 'column', gap: 8, fontSize: 13 }}>
                {report.gaps.map((g, idx) => (
                  <div key={`g-${idx}`} style={{ color: 'var(--assist)' }}>{g}</div>
                ))}
                {report.insights.map((ins, idx) => (
                  <div key={`i-${idx}`}>{ins}</div>
                ))}
              </div>
            </Card>

            <Card title="Slow & fast learners">
              <div style={{ display: 'flex', flexDirection: 'column', gap: 10, fontSize: 12 }}>
                <div>
                  <strong>Slow learners:</strong>{' '}
                  <span className="mono">
                    {report.slowLearners.map((l) => `${l.rollNo || l.fullName} (${l.overallPct}% · ${l.reason})`).join(', ') || 'None'}
                  </span>
                </div>
                <div>
                  <strong>Fast learners:</strong>{' '}
                  <span className="mono">
                    {report.fastLearners.map((l) => `${l.rollNo || l.fullName} (${l.overallPct}% · ${l.reason})`).join(', ') || 'None'}
                  </span>
                </div>

                {(report.manualSlow.length > 0 || report.manualFast.length > 0) ? (
                  <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6 }}>
                    {[...report.manualSlow, ...report.manualFast].map((fl) => {
                      const st = studentNameMap.get(fl.student_id);
                      return (
                        <Chip key={fl.id} tone={fl.kind === 'slow' ? 'warn' : 'good'}>
                          {st?.roll_no ?? fl.student_id} ({fl.kind})
                          <button
                            type="button"
                            aria-label={`Remove flag for ${st?.roll_no ?? fl.student_id}`}
                            disabled={busyKey === `rm-flag-${fl.id}`}
                            onClick={() => void removeFlag(fl.id)}
                            style={{ border: 0, background: 'none', padding: '0 2px', cursor: 'pointer', color: 'inherit' }}
                          >
                            ×
                          </button>
                        </Chip>
                      );
                    })}
                  </div>
                ) : null}

                {report.rows.length > 0 ? (
                  <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6, paddingTop: 6, borderTop: '1px solid var(--border-soft)' }}>
                    <select
                      aria-label="Student to flag"
                      className="field field-sm"
                      value={activeFlagTargetId}
                      onChange={(e) => setManualFlagStudentId(e.target.value)}
                    >
                      {report.rows.map((r) => (
                        <option key={r.student.id} value={r.student.id}>
                          {r.student.roll_no ?? '—'} · {r.student.full_name}
                        </option>
                      ))}
                    </select>
                    <select
                      aria-label="Learner group"
                      className="field field-sm"
                      value={manualFlagKind}
                      onChange={(e) => setManualFlagKind(e.target.value as 'slow' | 'fast')}
                    >
                      <option value="slow">Slow list</option>
                      <option value="fast">Fast list</option>
                    </select>
                    <input
                      className="field field-sm"
                      aria-label="Flag note"
                      placeholder="Note…"
                      value={manualFlagNote}
                      onChange={(e) => setManualFlagNote(e.target.value)}
                    />
                    <button
                      type="button"
                      className="btn field-sm"
                      disabled={busyKey === 'flag'}
                      onClick={() => void addManualFlag()}
                    >
                      Add flag
                    </button>
                  </div>
                ) : null}
              </div>
            </Card>
          </div>

          <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8 }}>
            <button type="button" className="btn" onClick={exportInternalSheetCsv}>
              Mark sheet (CSV)
            </button>
            <button
              type="button"
              className="btn btn-primary"
              disabled={busyKey === 'snapshot'}
              onClick={() => void saveSnapshot()}
            >
              {busyKey === 'snapshot' ? 'Saving snapshot…' : 'Save snapshot'}
            </button>
          </div>
        </div>
      ) : null}

      {tab === 'students' ? (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
          <Card>
            <div style={{ display: 'flex', flexWrap: 'wrap', gap: 12, justifyContent: 'space-between', alignItems: 'center' }}>
              <label className="field-label">
                Student selector
                <select
                  className="field field-sm"
                  value={activeStudent?.student.id ?? ''}
                  onChange={(e) => setSelectedStudentId(e.target.value)}
                >
                  {report.rows.map((r) => (
                    <option key={r.student.id} value={r.student.id}>
                      {r.student.roll_no ?? '—'} · {r.student.full_name} ({r.internalPct}/100)
                    </option>
                  ))}
                </select>
              </label>
              <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8 }}>
                {activeStudent ? (
                  <Link className="btn btn-teal field-sm" to={`/faculty/c/${course.id}/lab-file/${activeStudent.student.id}`}>
                    Open full lab file
                  </Link>
                ) : null}
                <button type="button" className="btn field-sm" onClick={() => window.print()}>
                  Print all lab files
                </button>
                <button type="button" className="btn field-sm" onClick={downloadAllZip}>
                  All students (ZIP)
                </button>
              </div>
            </div>
          </Card>

          <Card title="Student lab files roster" flush>
            <div style={{ overflowX: 'auto' }}>
              <table>
                <thead>
                  <tr>
                    <th>Roll</th>
                    <th>Student</th>
                    <th>Batch</th>
                    <th style={{ textAlign: 'right' }}>Attendance</th>
                    <th style={{ textAlign: 'right' }}>Internal /100</th>
                    <th>Last submitted</th>
                    <th />
                  </tr>
                </thead>
                <tbody>
                  {report.rows.length === 0 ? (
                    <tr>
                      <td colSpan={7} style={{ textAlign: 'center', color: 'var(--muted)', padding: 14 }}>
                        No enrolled students yet.
                      </td>
                    </tr>
                  ) : (
                    report.rows.map((r) => (
                      <tr key={r.student.id}>
                        <td className="mono">{r.student.roll_no ?? '—'}</td>
                        <td>{r.student.full_name}</td>
                        <td>{r.batch?.name ?? '—'}</td>
                        <td className="mono" style={{ textAlign: 'right' }}>{r.attendancePct}%</td>
                        <td className="mono" style={{ textAlign: 'right', fontWeight: 600 }}>{r.internalPct}/100</td>
                        <td className="mono" style={{ fontSize: 12 }}>
                          {r.lastSubmittedAt ? formatTimeIst(r.lastSubmittedAt) : '—'}
                        </td>
                        <td style={{ textAlign: 'right' }}>
                          <Link className="btn field-sm" to={`/faculty/c/${course.id}/lab-file/${r.student.id}`}>
                            Lab file
                          </Link>
                        </td>
                      </tr>
                    ))
                  )}
                </tbody>
              </table>
            </div>
          </Card>

          {activeStudent ? (
            <Card title={`Per-session rubric breakdown · ${activeStudent.student.full_name} (${activeStudent.student.roll_no ?? '—'})`} flush>
              <div style={{ overflowX: 'auto' }}>
                <table style={{ fontSize: 12 }}>
                  <thead>
                    <tr>
                      <th>Session</th>
                      <th>Topic</th>
                      <th>Att</th>
                      <th>Pre</th>
                      <th>Post</th>
                      <th>Vis</th>
                      <th>Hid</th>
                      <th>Viva</th>
                      <th>Total /50</th>
                    </tr>
                  </thead>
                  <tbody>
                    {activeStudent.sessions.filter((s) => s.conducted).map((s) => (
                      <tr key={s.session.id}>
                        <td className="mono">S{s.session.n}</td>
                        <td>{s.session.topic}</td>
                        <td className="mono">{s.breakdown.att}</td>
                        <td className="mono">{s.breakdown.pre}</td>
                        <td className="mono">{s.breakdown.post}</td>
                        <td className="mono">{s.breakdown.vis}</td>
                        <td className="mono">{s.breakdown.hid}</td>
                        <td className="mono">{s.breakdown.viva}</td>
                        <td className="mono" style={{ fontWeight: 600 }}>{s.breakdown.total}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </Card>
          ) : null}
        </div>
      ) : null}

      {tab === 'final' ? (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
          <Card
            title="Final marks submission pipeline"
            actions={
              <Chip
                tone={
                  dataset.course.final_status === 'coe_accepted'
                    ? 'good'
                    : dataset.course.final_status === 'returned'
                      ? 'bad'
                      : dataset.course.final_status === 'sent' || dataset.course.final_status === 'hod_approved'
                        ? 'warn'
                        : 'neutral'
                }
              >
                {dataset.course.final_status}
              </Chip>
            }
          >
            <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
              <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8 }}>
                <Chip tone={['sent', 'hod_approved', 'coe_accepted'].includes(dataset.course.final_status) ? 'good' : 'neutral'}>
                  1. Faculty submitted
                </Chip>
                <Chip tone={['hod_approved', 'coe_accepted'].includes(dataset.course.final_status) ? 'good' : 'neutral'}>
                  2. HOD approved
                </Chip>
                <Chip tone={dataset.course.final_status === 'coe_accepted' ? 'good' : 'neutral'}>
                  3. CoE accepted
                </Chip>
              </div>

              {dataset.course.final_status === 'returned' && latestFinalRemark ? (
                <Banner tone="err">Returned with remark: {latestFinalRemark}</Banner>
              ) : null}

              <div>
                <button
                  type="button"
                  className="btn btn-primary"
                  disabled={
                    busyKey === 'final' ||
                    ['sent', 'hod_approved', 'coe_accepted'].includes(dataset.course.final_status)
                  }
                  onClick={() => void submitFinalMarks()}
                >
                  {busyKey === 'final'
                    ? 'Submitting…'
                    : dataset.course.final_status === 'returned'
                      ? 'Resubmit final marks to HOD'
                      : 'Submit final marks to HOD'}
                </button>
              </div>
            </div>
          </Card>

          <Card title="Immutable approval history" flush>
            {finalApprovals.length === 0 ? (
              <div style={{ padding: 16 }}>
                <Empty title="No final-marks decisions recorded yet" body="Submissions to HOD and CoE decisions appear here." />
              </div>
            ) : (
              <table>
                <thead>
                  <tr>
                    <th>Decision</th>
                    <th>Remark</th>
                    <th>Hash</th>
                    <th>At</th>
                  </tr>
                </thead>
                <tbody>
                  {finalApprovals.map((ap) => (
                    <tr key={ap.id}>
                      <td>
                        <Chip tone={ap.decision === 'approved' ? 'good' : 'bad'}>{ap.decision}</Chip>
                      </td>
                      <td>{ap.remark || '—'}</td>
                      <td className="mono" style={{ fontSize: 11 }}>{ap.content_hash.slice(0, 12)}…</td>
                      <td className="mono" style={{ fontSize: 12 }}>{formatTimeIst(ap.at)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </Card>
        </div>
      ) : null}
      </PrintableReportFrame>
    </div>
  );
}
