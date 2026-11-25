import { useState, type FormEvent } from 'react';
import { Banner, Card, Chip, Modal, statusTone } from '../../../components/ui';
import { errorMessage } from '../../../lib/errors';
import { useLoad } from '../../../lib/hooks';
import { inferBloomLevel, inferCoPoLevels } from '../../../lib/logic/bloom';
import { planChecks, rubricSum } from '../../../lib/logic/checks';
import { pdfToText } from '../../../lib/pdf';
import { fn, rpc, supabase } from '../../../lib/supabase';
import type { CoPoMapRow, Course, CourseOutcome, RubricWeights } from '../../../lib/types';

const ALL_LANGS = [
  { id: 'c', label: 'C (gcc)' },
  { id: 'cpp', label: 'C++ (g++)' },
  { id: 'java', label: 'Java 21' },
  { id: 'python', label: 'Python 3.12' },
  { id: 'rust', label: 'Rust' },
  { id: 'go', label: 'Go' },
] as const;

const DEFAULT_PO_COLS = ['PO1', 'PO2', 'PO3', 'PO5', 'PO11', 'PSO1'] as const;

interface DeptOutcomeDef {
  code: string;
  kind: 'PO' | 'PSO';
  statement: string;
}

const RUBRIC_DEFS: ReadonlyArray<{ key: keyof RubricWeights; label: string; how: string }> = [
  { key: 'att', label: 'Attendance', how: 'Present in the session' },
  { key: 'pre', label: 'Pre-test', how: '5 MCQs before the lab, one attempt' },
  { key: 'post', label: 'Post-test', how: '5 MCQs, same day, after hidden tests pass' },
  { key: 'vis', label: 'Visible test cases', how: '2 per question' },
  { key: 'hid', label: 'Hidden test cases', how: '3 per question' },
  { key: 'viva', label: 'Viva', how: 'Faculty marks, out of 10 per session' },
];

interface DraftOutcomeRow {
  code: string;
  statement: string;
  btl: number;
  unit: number;
}

interface DraftMapRow {
  co: string;
  po: string;
  level: number;
}

export function CourseSetupStep({
  course,
  outcomes,
  coPoMap,
  onNotify,
  onRefresh,
}: {
  course: Course;
  outcomes: readonly CourseOutcome[];
  coPoMap: readonly CoPoMapRow[];
  onNotify: (msg: string, ok: boolean) => void;
  onRefresh: () => void;
}) {
  const locked = course.plan_status === 'sent' || course.plan_status === 'approved';

  const [details, setDetails] = useState({
    code: course.code,
    title: course.title,
    ltpc: course.ltpc,
    programme: course.programme,
    semester: course.semester,
    section: course.section,
    academic_year: course.academic_year,
    allowed_langs: course.allowed_langs,
  });

  const [rubric, setRubric] = useState<RubricWeights>(course.rubric);
  const [newCoCode, setNewCoCode] = useState(`CO${outcomes.length + 1}`);
  const [newCoStmt, setNewCoStmt] = useState('');
  const [newCoUnit, setNewCoUnit] = useState(1);
  const [editingCoId, setEditingCoId] = useState<string | null>(null);
  const [editCoCode, setEditCoCode] = useState('');
  const [editCoStmt, setEditCoStmt] = useState('');
  const [editCoUnit, setEditCoUnit] = useState(1);
  const [editCoBtl, setEditCoBtl] = useState(3);
  const [busy, setBusy] = useState(false);

  const inferredBloom = inferBloomLevel(newCoStmt);

  // F1a Syllabus Assist modal state
  const [assistOpen, setAssistOpen] = useState(false);
  const [syllabusText, setSyllabusText] = useState('');
  const [draftOutcomes, setDraftOutcomes] = useState<DraftOutcomeRow[]>([]);
  const [draftMap, setDraftMap] = useState<DraftMapRow[]>([]);
  const [assistBusy, setAssistBusy] = useState(false);
  const [assistErr, setAssistErr] = useState<string | null>(null);

  const totalRubric = rubricSum(rubric);
  const mappedRefs = coPoMap.filter((m) => m.level > 0).map((m) => m.co_id);
  const checks = planChecks(rubric, outcomes, mappedRefs);

  const { data: deptOutcomes } = useLoad(async () => {
    if (!course.department_id) return [] as DeptOutcomeDef[];
    const { data, error } = await supabase
      .from('department_outcomes')
      .select('code, kind, statement')
      .eq('department_id', course.department_id)
      .order('kind', { ascending: true })
      .order('code', { ascending: true });
    if (error || !data) return [] as DeptOutcomeDef[];
    return (data as DeptOutcomeDef[]).sort((a, b) => {
      if (a.kind !== b.kind) return a.kind === 'PO' ? -1 : 1;
      return a.code.localeCompare(b.code, undefined, { numeric: true });
    });
  }, [course.department_id]);

  const poColumns: readonly DeptOutcomeDef[] =
    deptOutcomes && deptOutcomes.length > 0
      ? deptOutcomes
      : DEFAULT_PO_COLS.map((c) => ({
          code: c,
          kind: c.startsWith('PSO') ? 'PSO' : 'PO',
          statement: '',
        }));

  const levelLookup = new Map<string, number>();
  for (const m of coPoMap) {
    levelLookup.set(`${m.co_id}:${m.po_code}`, m.level);
  }

  async function saveDetails(e: FormEvent) {
    e.preventDefault();
    if (locked) return;
    if (details.allowed_langs.length === 0) {
      onNotify('Select at least one allowed programming language.', false);
      return;
    }
    setBusy(true);
    try {
      const { error } = await supabase
        .from('courses')
        .update({
          code: details.code.trim().toUpperCase(),
          title: details.title.trim(),
          ltpc: details.ltpc.trim(),
          programme: details.programme.trim(),
          semester: details.semester.trim(),
          section: details.section.trim(),
          academic_year: details.academic_year.trim(),
          allowed_langs: details.allowed_langs,
        })
        .eq('id', course.id);
      if (error) throw new Error(error.message);
      onNotify('Course details saved.', true);
      onRefresh();
    } catch (err) {
      onNotify(errorMessage(err), false);
    } finally {
      setBusy(false);
    }
  }

  async function recomputeCoPoMap(
    targetOutcomes: ReadonlyArray<{ id: string; code: string; statement: string; btl: number }>,
  ) {
    if (locked || targetOutcomes.length === 0) return;

    const poListText = poColumns
      .map((p) => `${p.code}${p.statement ? `: ${p.statement}` : ''}`)
      .join('\n');
    const coListText = targetOutcomes
      .map((c) => `${c.code} (L${c.btl}): ${c.statement}`)
      .join('\n');

    let aiMaps: Array<{ co_code: string; po_code: string; level: number }> = [];
    try {
      const res = await fn<{ co_po?: Array<{ co_code: string; po_code: string; level: number }> }>(
        'ai-generate',
        {
          kind: 'outcomes',
          courseId: course.id,
          syllabusText: `Course outcomes:\n${coListText}\n\nRegistered Department POs and PSOs:\n${poListText}`,
        },
      );
      if (Array.isArray(res?.co_po)) {
        aiMaps = res.co_po;
      }
    } catch {
      // Fall back to deterministic Bloom + keyword mapping below.
    }

    const allowedPoSet = new Set(poColumns.map((p) => p.code.toUpperCase()));
    const aiByPair = new Map<string, number>();
    for (const m of aiMaps) {
      const codeUpper = m.po_code.trim().toUpperCase();
      if (allowedPoSet.has(codeUpper)) {
        aiByPair.set(`${m.co_code.trim().toUpperCase()}:${codeUpper}`, m.level);
      }
    }

    const upserts: Array<{
      course_id: string;
      institution_id: string;
      co_id: string;
      po_code: string;
      level: number;
    }> = [];

    for (const co of targetOutcomes) {
      const fallbackLevels = inferCoPoLevels(co.statement, co.btl, poColumns);
      const fallbackMap = new Map(fallbackLevels.map((l) => [l.po_code, l.level]));
      for (const po of poColumns) {
        const aiLvl = aiByPair.get(`${co.code.toUpperCase()}:${po.code.toUpperCase()}`);
        const lvl = typeof aiLvl === 'number' ? Math.max(0, Math.min(3, Math.round(aiLvl))) : (fallbackMap.get(po.code) ?? 0);
        if (lvl > 0) {
          upserts.push({
            course_id: course.id,
            institution_id: course.institution_id,
            co_id: co.id,
            po_code: po.code,
            level: lvl,
          });
        }
      }
    }

    const coIds = targetOutcomes.map((c) => c.id);
    await supabase.from('co_po_map').delete().in('co_id', coIds);
    if (upserts.length > 0) {
      const { error } = await supabase
        .from('co_po_map')
        .upsert(upserts, { onConflict: 'co_id,po_code' });
      if (error) throw new Error(error.message);
    }
  }

  async function addOutcome(e: FormEvent) {
    e.preventDefault();
    if (locked || !newCoStmt.trim()) return;
    setBusy(true);
    try {
      let assignedBtl: number = inferredBloom.btl;
      // Try Assist AI classification when available; fall back seamlessly to local Bloom analyzer.
      try {
        const res = await fn<{ outcomes?: Array<{ btl?: number }> }>('ai-generate', {
          kind: 'outcomes',
          courseId: course.id,
          syllabusText: newCoStmt.trim(),
        });
        const aiBtl = res?.outcomes?.[0]?.btl;
        if (typeof aiBtl === 'number' && aiBtl >= 1 && aiBtl <= 6) {
          assignedBtl = aiBtl;
        }
      } catch {
        // Local Bloom analyzer already inferred assignedBtl.
      }

      const codeUpper = newCoCode.trim().toUpperCase();
      const stmtClean = newCoStmt.trim();
      const { data: inserted, error } = await supabase
        .from('course_outcomes')
        .insert({
          course_id: course.id,
          institution_id: course.institution_id,
          code: codeUpper,
          statement: stmtClean,
          btl: assignedBtl,
          unit: newCoUnit,
        })
        .select('id, code, statement, btl')
        .single();
      if (error) throw new Error(error.message);

      if (inserted) {
        await recomputeCoPoMap([inserted as { id: string; code: string; statement: string; btl: number }]);
      }

      setNewCoStmt('');
      setNewCoCode(`CO${outcomes.length + 2}`);
      onNotify(`Outcome added (Assist assigned L${assignedBtl}) and CO–PO matrix updated.`, true);
      onRefresh();
    } catch (err) {
      onNotify(errorMessage(err), false);
    } finally {
      setBusy(false);
    }
  }

  function startEditOutcome(c: CourseOutcome) {
    setEditingCoId(c.id);
    setEditCoCode(c.code);
    setEditCoStmt(c.statement);
    setEditCoUnit(c.unit);
    setEditCoBtl(c.btl);
  }

  async function saveEditOutcome(c: CourseOutcome) {
    if (locked || !editCoStmt.trim()) return;
    setBusy(true);
    try {
      const codeUpper = editCoCode.trim().toUpperCase() || c.code;
      const stmtClean = editCoStmt.trim();
      const stmtChanged = stmtClean !== c.statement;
      const btlToSave =
        stmtChanged && editCoBtl === c.btl ? inferBloomLevel(stmtClean).btl : editCoBtl;

      const { error } = await supabase
        .from('course_outcomes')
        .update({
          code: codeUpper,
          statement: stmtClean,
          unit: editCoUnit,
          btl: btlToSave,
        })
        .eq('id', c.id);
      if (error) throw new Error(error.message);

      await recomputeCoPoMap([{ id: c.id, code: codeUpper, statement: stmtClean, btl: btlToSave }]);
      setEditingCoId(null);
      onNotify(`Updated ${codeUpper} (L${btlToSave}) and recomputed CO–PO matrix.`, true);
      onRefresh();
    } catch (err) {
      onNotify(errorMessage(err), false);
    } finally {
      setBusy(false);
    }
  }

  async function overrideOutcomeBtl(id: string, btl: number) {
    if (locked) return;
    setBusy(true);
    try {
      const { error } = await supabase.from('course_outcomes').update({ btl }).eq('id', id);
      if (error) throw new Error(error.message);
      onNotify(`BTL updated to L${btl}.`, true);
      onRefresh();
    } catch (err) {
      onNotify(errorMessage(err), false);
    } finally {
      setBusy(false);
    }
  }

  async function deleteOutcome(id: string) {
    if (locked) return;
    setBusy(true);
    try {
      const { error } = await supabase.from('course_outcomes').delete().eq('id', id);
      if (error) throw new Error(error.message);
      onRefresh();
    } catch (err) {
      onNotify(errorMessage(err), false);
    } finally {
      setBusy(false);
    }
  }

  async function cyclePoLevel(coId: string, poCode: string) {
    if (locked) return;
    const current = levelLookup.get(`${coId}:${poCode}`) ?? 0;
    const next = (current + 1) % 4;
    try {
      if (next === 0) {
        const { error } = await supabase
          .from('co_po_map')
          .delete()
          .eq('co_id', coId)
          .eq('po_code', poCode);
        if (error) throw new Error(error.message);
      } else {
        const { error } = await supabase.from('co_po_map').upsert(
          {
            course_id: course.id,
            institution_id: course.institution_id,
            co_id: coId,
            po_code: poCode,
            level: next,
          },
          { onConflict: 'co_id,po_code' },
        );
        if (error) throw new Error(error.message);
      }
      onRefresh();
    } catch (err) {
      onNotify(errorMessage(err), false);
    }
  }

  async function saveRubric() {
    if (locked) return;
    setBusy(true);
    try {
      const { error } = await supabase
        .from('courses')
        .update({ rubric })
        .eq('id', course.id);
      if (error) throw new Error(error.message);
      onNotify('Rubric saved.', true);
      onRefresh();
    } catch (err) {
      onNotify(errorMessage(err), false);
    } finally {
      setBusy(false);
    }
  }

  async function submitPlan() {
    setBusy(true);
    try {
      const { error: rubErr } = await supabase
        .from('courses')
        .update({ rubric })
        .eq('id', course.id);
      if (rubErr) throw new Error(rubErr.message);

      await rpc('submit_course_plan', { p_course_id: course.id });
      onNotify('Course plan sent to the department HOD for approval.', true);
      onRefresh();
    } catch (err) {
      onNotify(errorMessage(err), false);
    } finally {
      setBusy(false);
    }
  }

  async function handleSyllabusFile(file: File | null) {
    if (!file) return;
    setAssistErr(null);
    try {
      if (file.name.toLowerCase().endsWith('.pdf')) {
        const text = await pdfToText(file);
        setSyllabusText(text);
      } else {
        const text = await file.text();
        setSyllabusText(text);
      }
    } catch (err) {
      setAssistErr(errorMessage(err));
    }
  }

  async function generateFromSyllabus() {
    setAssistErr(null);
    if (syllabusText.trim().length < 20) {
      setAssistErr('Paste syllabus text or upload a syllabus PDF/TXT (at least 20 characters).');
      return;
    }
    setAssistBusy(true);
    try {
      const res = await fn<{ draft: { outcomes: DraftOutcomeRow[]; map: DraftMapRow[] } }>('ai-generate', {
        kind: 'outcomes',
        course_id: course.id,
        syllabus: syllabusText.trim(),
      });
      setDraftOutcomes(res.draft.outcomes);
      setDraftMap(res.draft.map);
    } catch (err) {
      setAssistErr(errorMessage(err));
    } finally {
      setAssistBusy(false);
    }
  }

  async function insertDraftOutcomes() {
    if (draftOutcomes.length === 0 || locked) return;
    setAssistBusy(true);
    setAssistErr(null);
    try {
      await supabase.from('course_outcomes').delete().eq('course_id', course.id);

      const { data: insertedCos, error: coErr } = await supabase
        .from('course_outcomes')
        .insert(
          draftOutcomes.map((o) => ({
            course_id: course.id,
            institution_id: course.institution_id,
            code: o.code.trim().toUpperCase(),
            statement: o.statement.trim(),
            btl: o.btl,
            unit: o.unit,
          })),
        )
        .select();
      if (coErr) throw new Error(coErr.message);

      const idByCode = new Map(
        ((insertedCos ?? []) as CourseOutcome[]).map((c) => [c.code.toUpperCase(), c.id]),
      );

      const mapRows = draftMap
        .map((m) => {
          const coId = idByCode.get(m.co.toUpperCase());
          if (!coId || m.level <= 0) return null;
          return {
            course_id: course.id,
            institution_id: course.institution_id,
            co_id: coId,
            po_code: m.po.toUpperCase(),
            level: m.level,
          };
        })
        .filter((x): x is NonNullable<typeof x> => x !== null);

      if (mapRows.length > 0) {
        const { error: mapErr } = await supabase.from('co_po_map').insert(mapRows);
        if (mapErr) throw new Error(mapErr.message);
      }

      setAssistOpen(false);
      onNotify(`Inserted ${draftOutcomes.length} drafted COs and CO–PO mappings.`, true);
      onRefresh();
    } catch (err) {
      setAssistErr(errorMessage(err));
    } finally {
      setAssistBusy(false);
    }
  }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
      <Card
        title="Course details"
        actions={
          <button
            type="button"
            className="btn btn-teal field-sm"
            disabled={locked}
            onClick={() => setAssistOpen(true)}
          >
            Draft from syllabus with Assist
          </button>
        }
      >
        <form onSubmit={saveDetails} style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(170px, 1fr))', gap: 12 }}>
            <label className="field-label">
              Course code
              <input
                className="field mono"
                disabled={locked}
                value={details.code}
                onChange={(e) => setDetails({ ...details, code: e.target.value })}
              />
            </label>
            <label className="field-label">
              Course title
              <input
                className="field"
                disabled={locked}
                value={details.title}
                onChange={(e) => setDetails({ ...details, title: e.target.value })}
              />
            </label>
            <label className="field-label">
              L-T-P-C
              <input
                className="field mono"
                disabled={locked}
                value={details.ltpc}
                onChange={(e) => setDetails({ ...details, ltpc: e.target.value })}
              />
            </label>
            <label className="field-label">
              Programme
              <input
                className="field"
                disabled={locked}
                value={details.programme}
                onChange={(e) => setDetails({ ...details, programme: e.target.value })}
              />
            </label>
            <label className="field-label">
              Semester
              <input
                className="field"
                disabled={locked}
                value={details.semester}
                onChange={(e) => setDetails({ ...details, semester: e.target.value })}
              />
            </label>
            <label className="field-label">
              Section
              <input
                className="field"
                disabled={locked}
                value={details.section}
                onChange={(e) => setDetails({ ...details, section: e.target.value })}
              />
            </label>
            <label className="field-label">
              Academic year
              <input
                className="field mono"
                disabled={locked}
                value={details.academic_year}
                onChange={(e) => setDetails({ ...details, academic_year: e.target.value })}
              />
            </label>
          </div>

          <div style={{ display: 'flex', flexWrap: 'wrap', gap: 12, alignItems: 'center' }}>
            <span style={{ fontSize: 12, color: 'var(--muted)' }}>Allowed languages:</span>
            {ALL_LANGS.map((lang) => {
              const checked = details.allowed_langs.includes(lang.id);
              return (
                <label
                  key={lang.id}
                  style={{ display: 'inline-flex', alignItems: 'center', gap: 6, fontSize: 13 }}
                >
                  <input
                    type="checkbox"
                    disabled={locked}
                    checked={checked}
                    onChange={() => {
                      const next = checked
                        ? details.allowed_langs.filter((x) => x !== lang.id)
                        : [...details.allowed_langs, lang.id];
                      setDetails({ ...details, allowed_langs: next });
                    }}
                  />
                  {lang.label}
                </label>
              );
            })}
          </div>

          {!locked ? (
            <div>
              <button type="submit" className="btn" disabled={busy}>
                Save details
              </button>
            </div>
          ) : null}
        </form>
      </Card>

      <div style={{ display: 'flex', flexWrap: 'wrap', gap: 16, alignItems: 'flex-start' }}>
        <div style={{ flex: '3 1 420px' }}>
          <Card title="Course outcomes and Bloom levels" flush>
            <div style={{ overflowX: 'auto' }}>
              <table>
                <thead>
                  <tr>
                    <th>CO</th>
                    <th>Statement</th>
                    <th>Unit</th>
                    <th>BTL</th>
                    {!locked ? <th /> : null}
                  </tr>
                </thead>
                <tbody>
                  {outcomes.length === 0 ? (
                    <tr>
                      <td colSpan={5} style={{ color: 'var(--muted)' }}>
                        No outcomes yet. Add below or use "Draft from syllabus with Assist".
                      </td>
                    </tr>
                  ) : (
                    outcomes.map((c) =>
                      editingCoId === c.id && !locked ? (
                        <tr key={c.id}>
                          <td>
                            <input
                              className="field field-sm mono"
                              aria-label="Edit CO code"
                              value={editCoCode}
                              onChange={(e) => setEditCoCode(e.target.value)}
                              style={{ width: 64 }}
                            />
                          </td>
                          <td>
                            <input
                              className="field field-sm"
                              aria-label="Edit CO statement"
                              value={editCoStmt}
                              onChange={(e) => setEditCoStmt(e.target.value)}
                              style={{ width: '100%', minWidth: 160 }}
                            />
                          </td>
                          <td>
                            <input
                              className="field field-sm mono"
                              type="number"
                              min={1}
                              max={10}
                              aria-label="Edit CO unit"
                              value={editCoUnit}
                              onChange={(e) => setEditCoUnit(Number(e.target.value) || 1)}
                              style={{ width: 54 }}
                            />
                          </td>
                          <td>
                            <select
                              aria-label="Edit CO BTL"
                              className="field field-sm mono"
                              value={editCoBtl}
                              onChange={(e) => setEditCoBtl(Number(e.target.value))}
                            >
                              {[1, 2, 3, 4, 5, 6].map((b) => (
                                <option key={b} value={b}>
                                  L{b}
                                </option>
                              ))}
                            </select>
                          </td>
                          <td style={{ textAlign: 'right', whiteSpace: 'nowrap' }}>
                            <div style={{ display: 'inline-flex', gap: 6 }}>
                              <button
                                type="button"
                                className="btn btn-primary field-sm"
                                disabled={busy}
                                onClick={() => void saveEditOutcome(c)}
                              >
                                Save
                              </button>
                              <button
                                type="button"
                                className="btn field-sm"
                                disabled={busy}
                                onClick={() => setEditingCoId(null)}
                              >
                                Cancel
                              </button>
                            </div>
                          </td>
                        </tr>
                      ) : (
                        <tr key={c.id}>
                          <td className="mono" style={{ color: 'var(--muted)' }}>
                            {c.code}
                          </td>
                          <td>{c.statement}</td>
                          <td className="mono">U{c.unit}</td>
                          <td className="mono">
                            {locked ? (
                              `L${c.btl}`
                            ) : (
                              <select
                                aria-label={`Override BTL for ${c.code}`}
                                className="field field-sm mono"
                                disabled={busy}
                                value={c.btl}
                                onChange={(e) => void overrideOutcomeBtl(c.id, Number(e.target.value))}
                              >
                                {[1, 2, 3, 4, 5, 6].map((b) => (
                                  <option key={b} value={b}>
                                    L{b}
                                  </option>
                                ))}
                              </select>
                            )}
                          </td>
                          {!locked ? (
                            <td style={{ textAlign: 'right', whiteSpace: 'nowrap' }}>
                              <div style={{ display: 'inline-flex', gap: 6 }}>
                                <button
                                  type="button"
                                  className="btn field-sm"
                                  disabled={busy}
                                  onClick={() => startEditOutcome(c)}
                                >
                                  Edit
                                </button>
                                <button
                                  type="button"
                                  className="btn field-sm"
                                  disabled={busy}
                                  onClick={() => void deleteOutcome(c.id)}
                                >
                                  Remove
                                </button>
                              </div>
                            </td>
                          ) : null}
                        </tr>
                      ),
                    )
                  )}
                </tbody>
              </table>
            </div>
            {!locked ? (
              <form
                onSubmit={addOutcome}
                style={{
                  padding: '12px 16px',
                  borderTop: '1px solid var(--border-soft)',
                  display: 'flex',
                  flexWrap: 'wrap',
                  gap: 8,
                  alignItems: 'flex-end',
                }}
              >
                <label className="field-label">
                  Code
                  <input
                    className="field field-sm mono"
                    value={newCoCode}
                    onChange={(e) => setNewCoCode(e.target.value)}
                    style={{ width: 72 }}
                  />
                </label>
                <label className="field-label" style={{ flex: '1 1 200px' }}>
                  Statement
                  <input
                    className="field field-sm"
                    value={newCoStmt}
                    onChange={(e) => setNewCoStmt(e.target.value)}
                    placeholder="Write modular C programs..."
                  />
                </label>
                <label className="field-label">
                  Unit
                  <input
                    className="field field-sm mono"
                    type="number"
                    min={1}
                    max={10}
                    value={newCoUnit}
                    onChange={(e) => setNewCoUnit(Number(e.target.value) || 1)}
                    style={{ width: 60 }}
                  />
                </label>
                <span
                  className="mono"
                  style={{ fontSize: 11, color: 'var(--assist)', paddingBottom: 6 }}
                  title="Automatically analyzed by Assist; can be overridden in the table above"
                >
                  Assist BTL: L{inferredBloom.btl} ({inferredBloom.label})
                </span>
                <button type="submit" className="btn field-sm" disabled={busy}>
                  Add CO
                </button>
              </form>
            ) : null}
          </Card>
        </div>

        <div style={{ flex: '2 1 280px' }}>
          <Card
            title="CO–PO map"
            actions={
              !locked && outcomes.length > 0 ? (
                <button
                  type="button"
                  className="btn field-sm"
                  disabled={busy}
                  onClick={() => {
                    void (async () => {
                      setBusy(true);
                      try {
                        await recomputeCoPoMap(outcomes);
                        onNotify('CO–PO/PSO matrix mapped with Assist.', true);
                        onRefresh();
                      } catch (err) {
                        onNotify(errorMessage(err), false);
                      } finally {
                        setBusy(false);
                      }
                    })();
                  }}
                >
                  Auto-map with Assist
                </button>
              ) : undefined
            }
          >
            {outcomes.length === 0 ? (
              <p style={{ fontSize: 12, color: 'var(--muted)' }}>
                Add course outcomes to configure the CO–PO/PSO matrix.
              </p>
            ) : (
              <>
                <div style={{ overflowX: 'auto' }}>
                  <div
                    role="img"
                    aria-label="CO to PO mapping strengths"
                    style={{
                      display: 'grid',
                      gridTemplateColumns: `52px repeat(${poColumns.length}, minmax(42px, 1fr))`,
                      gap: 4,
                      fontSize: 11,
                    }}
                  >
                    <div />
                    {poColumns.map((po) => (
                      <div
                        key={po.code}
                        title={po.statement || po.code}
                        className="mono"
                        style={{ textAlign: 'center', color: 'var(--muted)' }}
                      >
                        {po.code}
                      </div>
                    ))}
                    {outcomes.map((co) => (
                      <div key={co.id} style={{ display: 'contents' }}>
                        <div className="mono" style={{ padding: '6px 2px', color: 'var(--muted)' }}>
                          {co.code}
                        </div>
                        {poColumns.map((po) => {
                          const lvl = levelLookup.get(`${co.id}:${po.code}`) ?? 0;
                          const bg = ['#F4F3EF', '#DCEBE6', '#9CC7BB', '#0E5E52'][lvl] ?? '#F4F3EF';
                          const fg = lvl === 3 ? '#FFFFFF' : '#141413';
                          return (
                            <button
                              key={`${co.id}-${po.code}`}
                              type="button"
                              disabled={locked}
                              aria-label={`${co.code} ${po.code} level ${lvl}`}
                              title={po.statement ? `${po.code}: ${po.statement}` : undefined}
                              onClick={() => void cyclePoLevel(co.id, po.code)}
                              className="mono"
                              style={{
                                minHeight: 28,
                                border: '1px solid var(--border-soft)',
                                borderRadius: 4,
                                background: bg,
                                color: fg,
                                cursor: locked ? 'default' : 'pointer',
                              }}
                            >
                              {lvl === 0 ? '·' : lvl}
                            </button>
                          );
                        })}
                      </div>
                    ))}
                  </div>
                </div>
                <div style={{ marginTop: 8, fontSize: 11, color: 'var(--muted)' }}>
                  Strength 0–3. Click a cell to cycle level.
                </div>
              </>
            )}
          </Card>
        </div>
      </div>

      <div style={{ display: 'flex', flexWrap: 'wrap', gap: 16, alignItems: 'flex-start' }}>
        <div style={{ flex: '3 1 420px' }}>
          <Card
            title="Marking rubric (internal)"
            actions={
              <Chip tone={totalRubric === 50 ? 'good' : 'bad'}>
                {totalRubric === 50 ? '50 / 50 valid' : `${totalRubric} / 50 (must equal 50)`}
              </Chip>
            }
            flush
          >
            <table>
              <thead>
                <tr>
                  <th>Component</th>
                  <th>Earned in each session</th>
                  <th style={{ textAlign: 'right' }}>Marks</th>
                </tr>
              </thead>
              <tbody>
                {RUBRIC_DEFS.map((r) => (
                  <tr key={r.key}>
                    <td style={{ fontWeight: 500 }}>{r.label}</td>
                    <td style={{ fontSize: 12, color: 'var(--muted)' }}>{r.how}</td>
                    <td style={{ textAlign: 'right' }}>
                      <input
                        aria-label={`${r.label} marks`}
                        className="field field-sm mono"
                        type="number"
                        min={0}
                        max={50}
                        disabled={locked}
                        value={rubric[r.key]}
                        onChange={(e) =>
                          setRubric({
                            ...rubric,
                            [r.key]: Math.max(0, Math.min(50, Number(e.target.value) || 0)),
                          })
                        }
                        style={{ width: 68, textAlign: 'right' }}
                      />
                    </td>
                  </tr>
                ))}
                <tr style={{ borderTop: '2px solid var(--ink)' }}>
                  <td style={{ fontWeight: 600 }}>Total</td>
                  <td style={{ fontSize: 12, color: 'var(--muted)' }}>
                    Reported out of 100 (scaled from {totalRubric})
                  </td>
                  <td className="mono" style={{ textAlign: 'right', fontWeight: 600 }}>
                    {totalRubric}
                  </td>
                </tr>
              </tbody>
            </table>
            {!locked ? (
              <div style={{ padding: '12px 16px', borderTop: '1px solid var(--border-soft)' }}>
                <button type="button" className="btn" disabled={busy} onClick={() => void saveRubric()}>
                  Save rubric
                </button>
              </div>
            ) : null}
          </Card>
        </div>

        <div style={{ flex: '2 1 280px', display: 'flex', flexDirection: 'column', gap: 12 }}>
          <Card title="Session rules">
            <div style={{ display: 'flex', flexDirection: 'column', gap: 8, fontSize: 13 }}>
              <div>
                <strong>Pre-test:</strong> 5 MCQs (2 easy, 2 medium, 1 hard), one attempt, closes when the lab starts.
              </div>
              <div>
                <strong>Lab:</strong> 2 coding questions, each with 2 visible and 3 hidden test cases.
              </div>
              <div>
                <strong>Post-test:</strong> 5 MCQs (1 easy, 2 medium, 2 hard); opens only after all hidden tests pass;
                closes 23:59 the same day.
              </div>
            </div>
          </Card>

          <Card
            title="HOD approval"
            actions={<Chip tone={statusTone(course.plan_status)}>{course.plan_status}</Chip>}
          >
            <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
              <div style={{ fontSize: 13, color: 'var(--muted)' }}>
                {course.plan_status === 'draft'
                  ? 'The course plan (details, COs, CO–PO map and rubric) goes to your department HOD as one package.'
                  : course.plan_status === 'sent'
                    ? 'Sent to your department HOD. Locked while under review.'
                    : course.plan_status === 'approved'
                      ? 'Approved by HOD. Later edits require re-approval.'
                      : `Declined by HOD: ${course.plan_remark ?? 'Update and resend.'}`}
              </div>

              <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
                {checks.map((ck) => (
                  <div
                    key={ck.text}
                    style={{
                      fontSize: 12,
                      color: ck.ok ? 'var(--teal)' : 'var(--assist)',
                    }}
                  >
                    {ck.ok ? '✓' : '!'} {ck.text}
                  </div>
                ))}
              </div>

              {!locked ? (
                <div>
                  <button
                    type="button"
                    className="btn btn-primary"
                    disabled={busy}
                    onClick={() => void submitPlan()}
                  >
                    Send course plan to HOD
                  </button>
                </div>
              ) : null}
            </div>
          </Card>
        </div>
      </div>

      <Modal
        open={assistOpen}
        title="Draft from syllabus with Assist"
        onClose={() => setAssistOpen(false)}
      >
        <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
          {assistErr ? <Banner tone="err">{assistErr}</Banner> : null}

          <label className="field-label">
            Upload syllabus (.pdf up to 2 MB, or .txt)
            <input
              type="file"
              accept=".pdf,.txt"
              onChange={(e) => void handleSyllabusFile(e.target.files?.[0] ?? null)}
            />
          </label>

          <label className="field-label">
            Or paste syllabus text
            <textarea
              className="field"
              rows={5}
              value={syllabusText}
              onChange={(e) => setSyllabusText(e.target.value)}
              placeholder="Unit 1: C basics... Unit 2: Loops..."
              style={{ height: 'auto', padding: 8 }}
            />
          </label>

          <div style={{ display: 'flex', gap: 8 }}>
            <button
              type="button"
              className="btn btn-primary"
              disabled={assistBusy}
              onClick={() => void generateFromSyllabus()}
            >
              {assistBusy ? 'Drafting…' : 'Draft COs with Assist (1 AI run)'}
            </button>
          </div>

          {draftOutcomes.length > 0 ? (
            <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
              <strong style={{ fontSize: 13 }}>Review & edit before inserting</strong>
              {draftOutcomes.map((o, i) => (
                <div
                  key={`${o.code}-${i}`}
                  style={{
                    display: 'grid',
                    gridTemplateColumns: '64px 1fr 62px 58px',
                    gap: 6,
                    alignItems: 'center',
                  }}
                >
                  <input
                    className="field field-sm mono"
                    value={o.code}
                    onChange={(e) =>
                      setDraftOutcomes((prev) =>
                        prev.map((x, j) => (j === i ? { ...x, code: e.target.value } : x)),
                      )
                    }
                  />
                  <input
                    className="field field-sm"
                    value={o.statement}
                    onChange={(e) =>
                      setDraftOutcomes((prev) =>
                        prev.map((x, j) => (j === i ? { ...x, statement: e.target.value } : x)),
                      )
                    }
                  />
                  <select
                    className="field field-sm mono"
                    value={o.btl}
                    onChange={(e) =>
                      setDraftOutcomes((prev) =>
                        prev.map((x, j) => (j === i ? { ...x, btl: Number(e.target.value) } : x)),
                      )
                    }
                  >
                    {[1, 2, 3, 4, 5, 6].map((b) => (
                      <option key={b} value={b}>
                        L{b}
                      </option>
                    ))}
                  </select>
                  <input
                    className="field field-sm mono"
                    type="number"
                    min={1}
                    max={10}
                    value={o.unit}
                    onChange={(e) =>
                      setDraftOutcomes((prev) =>
                        prev.map((x, j) => (j === i ? { ...x, unit: Number(e.target.value) || 1 } : x)),
                      )
                    }
                  />
                </div>
              ))}
              <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8 }}>
                <button type="button" className="btn" onClick={() => setAssistOpen(false)}>
                  Cancel
                </button>
                <button
                  type="button"
                  className="btn btn-teal"
                  disabled={assistBusy}
                  onClick={() => void insertDraftOutcomes()}
                >
                  Insert {draftOutcomes.length} COs into setup
                </button>
              </div>
            </div>
          ) : null}
        </div>
      </Modal>
    </div>
  );
}
