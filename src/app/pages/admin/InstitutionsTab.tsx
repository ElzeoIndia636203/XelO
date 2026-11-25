import { useState, type FormEvent } from 'react';
import { Card, Chip, Empty } from '../../../components/ui';
import { errorMessage } from '../../../lib/errors';
import { formatDateIst } from '../../../lib/format';
import { rpc } from '../../../lib/supabase';
import type { Department, Institution, School } from '../../../lib/types';

export interface CourseProgrammeInfo {
  id: string;
  institution_id: string;
  department_id: string | null;
  programme: string;
}

export function InstitutionsTab({
  institutions,
  schools,
  departments,
  courses = [],
  onNotify,
  onRefresh,
}: {
  institutions: readonly Institution[];
  schools: readonly School[];
  departments: readonly Department[];
  courses?: readonly CourseProgrammeInfo[];
  onNotify: (msg: string, ok: boolean) => void;
  onRefresh: () => Promise<void>;
}) {
  const [instName, setInstName] = useState('');
  const [instDomain, setInstDomain] = useState('');
  const [schoolInstId, setSchoolInstId] = useState(institutions[0]?.id ?? '');
  const [schoolName, setSchoolName] = useState('');
  const [deptInstId, setDeptInstId] = useState(institutions[0]?.id ?? '');
  const [deptSchoolId, setDeptSchoolId] = useState('');
  const [deptCode, setDeptCode] = useState('');
  const [deptName, setDeptName] = useState('');
  const [busy, setBusy] = useState(false);

  const activeSchoolInst = schoolInstId || institutions[0]?.id || '';
  const activeDeptInst = deptInstId || institutions[0]?.id || '';
  const schoolsForDept = schools.filter((s) => s.institution_id === activeDeptInst);
  const activeDeptSchool = deptSchoolId || schoolsForDept[0]?.id || '';

  async function addInstitution(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    try {
      await rpc('admin_create_institution', {
        p_name: instName,
        p_email_domain: instDomain,
      });
      setInstName('');
      setInstDomain('');
      onNotify('Institution added.', true);
      await onRefresh();
    } catch (err) {
      onNotify(errorMessage(err), false);
    } finally {
      setBusy(false);
    }
  }

  async function addSchool(e: FormEvent) {
    e.preventDefault();
    if (!activeSchoolInst) return;
    setBusy(true);
    try {
      await rpc('admin_create_school', {
        p_institution_id: activeSchoolInst,
        p_name: schoolName,
      });
      setSchoolName('');
      onNotify('School added.', true);
      await onRefresh();
    } catch (err) {
      onNotify(errorMessage(err), false);
    } finally {
      setBusy(false);
    }
  }

  async function addDepartment(e: FormEvent) {
    e.preventDefault();
    if (!activeDeptInst || !activeDeptSchool) return;
    setBusy(true);
    try {
      await rpc('admin_create_department', {
        p_institution_id: activeDeptInst,
        p_school_id: activeDeptSchool,
        p_code: deptCode,
        p_name: deptName,
      });
      setDeptCode('');
      setDeptName('');
      onNotify('Department added.', true);
      await onRefresh();
    } catch (err) {
      onNotify(errorMessage(err), false);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
      <div className="grid-2">
        <Card title="Add institution">
          <form onSubmit={addInstitution} style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
            <label className="field-label">
              Institution name
              <input
                className="field"
                value={instName}
                onChange={(e) => setInstName(e.target.value)}
                placeholder="Sanjivani University"
              />
            </label>
            <label className="field-label">
              Email domain
              <input
                className="field mono"
                value={instDomain}
                onChange={(e) => setInstDomain(e.target.value)}
                placeholder="sanjivani.edu.in"
              />
            </label>
            <div>
              <button type="submit" className="btn btn-primary" disabled={busy}>
                Add institution
              </button>
            </div>
          </form>
        </Card>

        <Card title="Add school">
          <form onSubmit={addSchool} style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
            <label className="field-label">
              Institution
              <select
                className="field"
                value={activeSchoolInst}
                onChange={(e) => setSchoolInstId(e.target.value)}
              >
                {institutions.length === 0 ? <option value="">No institutions</option> : null}
                {institutions.map((i) => (
                  <option key={i.id} value={i.id}>
                    {i.name}
                  </option>
                ))}
              </select>
            </label>
            <label className="field-label">
              School name
              <input
                className="field"
                value={schoolName}
                onChange={(e) => setSchoolName(e.target.value)}
                placeholder="School of Engineering and Technology"
              />
            </label>
            <div>
              <button type="submit" className="btn btn-primary" disabled={busy || !activeSchoolInst}>
                Add school
              </button>
            </div>
          </form>
        </Card>
      </div>

      <Card title="Add department">
        <form
          onSubmit={addDepartment}
          style={{ display: 'flex', flexWrap: 'wrap', gap: 12, alignItems: 'flex-end' }}
        >
          <label className="field-label">
            Institution
            <select
              className="field"
              value={activeDeptInst}
              onChange={(e) => {
                setDeptInstId(e.target.value);
                setDeptSchoolId('');
              }}
              style={{ minWidth: 180 }}
            >
              {institutions.map((i) => (
                <option key={i.id} value={i.id}>
                  {i.name}
                </option>
              ))}
            </select>
          </label>
          <label className="field-label">
            School
            <select
              className="field"
              value={activeDeptSchool}
              onChange={(e) => setDeptSchoolId(e.target.value)}
              style={{ minWidth: 210 }}
            >
              {schoolsForDept.length === 0 ? <option value="">No schools</option> : null}
              {schoolsForDept.map((s) => (
                <option key={s.id} value={s.id}>
                  {s.name}
                </option>
              ))}
            </select>
          </label>
          <label className="field-label">
            Code
            <input
              className="field mono"
              value={deptCode}
              onChange={(e) => setDeptCode(e.target.value)}
              placeholder="CSE"
              style={{ width: 90 }}
            />
          </label>
          <label className="field-label">
            Department name
            <input
              className="field"
              value={deptName}
              onChange={(e) => setDeptName(e.target.value)}
              placeholder="Computer Science and Engineering"
              style={{ width: 250 }}
            />
          </label>
          <button type="submit" className="btn btn-primary" disabled={busy || !activeDeptSchool}>
            Add department
          </button>
        </form>
      </Card>

      {institutions.length === 0 ? (
        <Empty title="No institutions yet" body="Add an institution above to begin onboarding staff." />
      ) : (
        <Card flush>
          <div style={{ overflowX: 'auto' }}>
            <table>
              <thead>
                <tr>
                  <th>Institution</th>
                  <th>Domain</th>
                  <th style={{ textAlign: 'right' }}>Schools</th>
                  <th style={{ textAlign: 'right' }}>Departments</th>
                  <th>Plan</th>
                  <th>Validity</th>
                </tr>
              </thead>
              <tbody>
                {institutions.map((inst) => {
                  const sCount = schools.filter((s) => s.institution_id === inst.id).length;
                  const dCount = departments.filter((d) => d.institution_id === inst.id).length;
                  return (
                    <tr key={inst.id}>
                      <td style={{ fontWeight: 500 }}>{inst.name}</td>
                      <td className="mono" style={{ fontSize: 12 }}>
                        @{inst.email_domain}
                      </td>
                      <td className="mono" style={{ textAlign: 'right' }}>
                        {sCount}
                      </td>
                      <td className="mono" style={{ textAlign: 'right' }}>
                        {dCount}
                      </td>
                      <td>
                        {inst.plan ? (
                          <Chip tone="good">{inst.plan === 'elite' ? 'Elite' : 'Pro'}</Chip>
                        ) : (
                          <Chip tone="neutral">No plan</Chip>
                        )}
                      </td>
                      <td className="mono" style={{ fontSize: 12, color: 'var(--muted)' }}>
                        {inst.plan_start && inst.plan_end
                          ? `${formatDateIst(inst.plan_start)} – ${formatDateIst(inst.plan_end)}`
                          : '—'}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </Card>
      )}
      {departments.length > 0 ? (
        <Card title="Departments & registered programmes" flush>
          <div style={{ overflowX: 'auto' }}>
            <table>
              <thead>
                <tr>
                  <th>Institution</th>
                  <th>School</th>
                  <th>Code</th>
                  <th>Department</th>
                  <th>Registered programmes</th>
                </tr>
              </thead>
              <tbody>
                {departments.map((dept) => {
                  const instName = institutions.find((i) => i.id === dept.institution_id)?.name ?? '—';
                  const schoolName = schools.find((s) => s.id === dept.school_id)?.name ?? '—';
                  const progs = Array.from(
                    new Set(
                      courses
                        .filter((c) => c.department_id === dept.id && c.programme.trim() !== '')
                        .map((c) => c.programme.trim()),
                    ),
                  ).sort();
                  return (
                    <tr key={dept.id}>
                      <td style={{ fontSize: 12 }}>{instName}</td>
                      <td style={{ fontSize: 12, color: 'var(--muted)' }}>{schoolName}</td>
                      <td className="mono" style={{ fontSize: 12 }}>
                        {dept.code}
                      </td>
                      <td style={{ fontWeight: 500 }}>{dept.name}</td>
                      <td>
                        {progs.length === 0 ? (
                          <span style={{ fontSize: 12, color: 'var(--muted)' }}>No programmes registered yet</span>
                        ) : (
                          <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6 }}>
                            {progs.map((p) => (
                              <Chip key={p} tone="neutral">
                                {p}
                              </Chip>
                            ))}
                          </div>
                        )}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </Card>
      ) : null}
    </div>
  );
}
