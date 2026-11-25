import { useState, type FormEvent } from 'react';
import { Card, Chip, Empty, Modal } from '../../../components/ui';
import { errorMessage } from '../../../lib/errors';
import { emailDomain } from '../../../lib/logic/domain';
import type { UserRole } from '../../../lib/logic/routing';
import { fn, rpc } from '../../../lib/supabase';
import type { Department, Institution, Invite, Profile, School } from '../../../lib/types';

const STAFF_ROLES: readonly { value: UserRole; label: string }[] = [
  { value: 'vc', label: 'VC' },
  { value: 'coe', label: 'CoE' },
  { value: 'dean', label: 'Dean' },
  { value: 'hod', label: 'HOD' },
  { value: 'faculty', label: 'Faculty' },
];

const ROLE_LABELS: Record<UserRole, string> = {
  super_admin: 'Super admin',
  vc: 'VC',
  coe: 'CoE',
  dean: 'Dean',
  hod: 'HOD',
  faculty: 'Faculty',
  student: 'Student',
};

const HARIPRASATH_K = 'hariprasathk@flyy4.com';
const GOWTHAM_SIR = 'gowtham.manivel@flyy4.com';
const DEV_ELZEO = 'dev.elzeo@flyy4.com';

function canManageTarget(actorEmail: string, targetEmail: string): boolean {
  const actor = actorEmail.trim().toLowerCase();
  const target = targetEmail.trim().toLowerCase();
  if (target === HARIPRASATH_K) return false;
  if (actor === DEV_ELZEO && target === GOWTHAM_SIR) return false;
  if (target === DEV_ELZEO && actor !== HARIPRASATH_K && actor !== GOWTHAM_SIR) return false;
  return true;
}

export function UsersTab({
  currentUserId,
  currentUserEmail = '',
  institutions,
  schools,
  departments,
  profiles,
  invites,
  onNotify,
  onRefresh,
}: {
  currentUserId: string;
  currentUserEmail?: string;
  institutions: readonly Institution[];
  schools: readonly School[];
  departments: readonly Department[];
  profiles: readonly Profile[];
  invites: readonly Invite[];
  onNotify: (msg: string, ok: boolean) => void;
  onRefresh: () => Promise<void>;
}) {
  const [name, setName] = useState('');
  const [instId, setInstId] = useState(institutions[0]?.id ?? '');
  const [email, setEmail] = useState('');
  const [role, setRole] = useState<UserRole>('hod');
  const [schoolId, setSchoolId] = useState('');
  const [deptId, setDeptId] = useState('');
  const [editingUser, setEditingUser] = useState<Profile | null>(null);
  const [editRoles, setEditRoles] = useState<UserRole[]>([]);
  const [editInstId, setEditInstId] = useState('');
  const [editSchoolId, setEditSchoolId] = useState('');
  const [editDeptId, setEditDeptId] = useState('');
  const [busy, setBusy] = useState(false);

  const activeInstId = instId || institutions[0]?.id || '';
  const selectedInst = institutions.find((i) => i.id === activeInstId) ?? null;
  const instSchools = schools.filter((s) => s.institution_id === activeInstId);
  const needsSchool = role === 'dean' || role === 'hod' || role === 'faculty';
  const needsDept = role === 'hod' || role === 'faculty';

  const activeSchoolId = needsSchool ? schoolId || instSchools[0]?.id || '' : '';
  const schoolDepts = departments.filter(
    (d) => d.institution_id === activeInstId && (!activeSchoolId || d.school_id === activeSchoolId),
  );
  const activeDeptId = needsDept ? deptId || schoolDepts[0]?.id || '' : '';

  const schoolMap = new Map(schools.map((s) => [s.id, s.name]));
  const deptMap = new Map(departments.map((d) => [d.id, d.name]));
  const instMap = new Map(institutions.map((i) => [i.id, i.name]));

  function scopeText(r: UserRole, iId: string | null, sId: string | null, dId: string | null): string {
    if (r === 'super_admin') return 'All institutions';
    if (r === 'vc' || r === 'coe') return instMap.get(iId ?? '') ?? 'University';
    if (r === 'dean') return schoolMap.get(sId ?? '') ?? 'School';
    return deptMap.get(dId ?? '') ?? schoolMap.get(sId ?? '') ?? instMap.get(iId ?? '') ?? 'Department';
  }

  async function handleInvite(e: FormEvent) {
    e.preventDefault();
    const cleanEmail = email.trim().toLowerCase();
    const cleanName = name.trim();
    if (!cleanName || !selectedInst) {
      onNotify('Enter a full name and select an institution.', false);
      return;
    }
    if (emailDomain(cleanEmail) !== selectedInst.email_domain.toLowerCase()) {
      onNotify(`Enter a valid @${selectedInst.email_domain} email address.`, false);
      return;
    }

    setBusy(true);
    try {
      await rpc<string>('admin_invite', {
        p_email: cleanEmail,
        p_role: role,
        p_full_name: cleanName,
        p_institution_id: selectedInst.id,
        p_school_id: activeSchoolId || null,
        p_department_id: activeDeptId || null,
      });

      let emailNotice = 'Invite email sent; they sign in with SSO.';
      try {
        await fn('send-invites', {
          institutionId: selectedInst.id,
          invites: [{ email: cleanEmail, fullName: cleanName, role }],
        });
      } catch {
        emailNotice = 'Login created. Invite email will send once mail delivery is configured.';
      }

      setName('');
      setEmail('');
      onNotify(`Login created for ${cleanEmail} as ${ROLE_LABELS[role]}. ${emailNotice}`, true);
      await onRefresh();
    } catch (err) {
      onNotify(errorMessage(err), false);
    } finally {
      setBusy(false);
    }
  }

  async function toggleActive(prof: Profile) {
    setBusy(true);
    try {
      await rpc('admin_set_active', { p_user_id: prof.id, p_active: !prof.active });
      onNotify(
        `${prof.email} ${prof.active ? 'disabled' : 'enabled'}.`,
        true,
      );
      await onRefresh();
    } catch (err) {
      onNotify(errorMessage(err), false);
    } finally {
      setBusy(false);
    }
  }

  async function removeUser(prof: Profile) {
    setBusy(true);
    try {
      await rpc('admin_remove_user', { p_user_id: prof.id, p_invite_id: null });
      onNotify(`${prof.email} removed.`, true);
      await onRefresh();
    } catch (err) {
      onNotify(errorMessage(err), false);
    } finally {
      setBusy(false);
    }
  }

  function openRoleEditor(u: Profile) {
    const current = u.roles && u.roles.length > 0 ? u.roles : [u.role];
    setEditingUser(u);
    setEditRoles(current);
    setEditInstId(u.institution_id ?? institutions[0]?.id ?? '');
    setEditSchoolId(u.school_id ?? '');
    setEditDeptId(u.department_id ?? '');
  }

  function toggleEditRole(r: UserRole) {
    setEditRoles((prev) =>
      prev.includes(r) ? prev.filter((x) => x !== r) : [...prev, r],
    );
  }

  async function saveUserRoles(e: FormEvent) {
    e.preventDefault();
    if (!editingUser || editRoles.length === 0) {
      onNotify('Select at least one role.', false);
      return;
    }
    setBusy(true);
    try {
      await rpc('admin_assign_roles', {
        p_user_id: editingUser.id,
        p_roles: editRoles,
        p_institution_id: editInstId || null,
        p_school_id: editSchoolId || null,
        p_department_id: editDeptId || null,
      });
      onNotify(`Updated roles for ${editingUser.email}.`, true);
      setEditingUser(null);
      await onRefresh();
    } catch (err) {
      onNotify(errorMessage(err), false);
    } finally {
      setBusy(false);
    }
  }

  async function removeInvite(inv: Invite) {
    setBusy(true);
    try {
      await rpc('admin_remove_user', { p_user_id: null, p_invite_id: inv.id });
      onNotify(`Invite for ${inv.email} removed.`, true);
      await onRefresh();
    } catch (err) {
      onNotify(errorMessage(err), false);
    } finally {
      setBusy(false);
    }
  }

  const staffProfiles = profiles.filter((p) => p.role !== 'student');
  const pendingInvites = invites.filter((i) => !i.accepted_at && i.role !== 'student');
  const studentCount = profiles.filter((p) => p.role === 'student').length;
  const activeFacultyCount = profiles.filter((p) => p.role === 'faculty' && p.active).length;

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
      <Card>
        <form
          onSubmit={handleInvite}
          style={{ display: 'flex', flexWrap: 'wrap', gap: 12, alignItems: 'flex-end' }}
        >
          <label className="field-label">
            Name
            <input
              className="field"
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="Dr. A. Kulkarni"
              style={{ width: 170 }}
            />
          </label>

          <label className="field-label">
            Institution
            <select
              className="field"
              value={activeInstId}
              onChange={(e) => {
                setInstId(e.target.value);
                setSchoolId('');
                setDeptId('');
              }}
              style={{ minWidth: 180 }}
            >
              {institutions.length === 0 ? <option value="">No institutions</option> : null}
              {institutions.map((inst) => (
                <option key={inst.id} value={inst.id}>
                  {inst.name}
                </option>
              ))}
            </select>
          </label>

          <label className="field-label">
            Institutional email
            <input
              className="field"
              type="email"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              placeholder={selectedInst ? `name@${selectedInst.email_domain}` : 'name@university.edu'}
              style={{ width: 220 }}
            />
          </label>

          <label className="field-label">
            Role
            <select
              className="field"
              value={role}
              onChange={(e) => {
                setRole(e.target.value as UserRole);
                setSchoolId('');
                setDeptId('');
              }}
            >
              {STAFF_ROLES.map((r) => (
                <option key={r.value} value={r.value}>
                  {r.label}
                </option>
              ))}
            </select>
          </label>

          {needsSchool ? (
            <label className="field-label">
              School
              <select
                className="field"
                value={activeSchoolId}
                onChange={(e) => {
                  setSchoolId(e.target.value);
                  setDeptId('');
                }}
                style={{ minWidth: 180 }}
              >
                {instSchools.length === 0 ? <option value="">No schools</option> : null}
                {instSchools.map((s) => (
                  <option key={s.id} value={s.id}>
                    {s.name}
                  </option>
                ))}
              </select>
            </label>
          ) : null}

          {needsDept ? (
            <label className="field-label">
              Department
              <select
                className="field"
                value={activeDeptId}
                onChange={(e) => setDeptId(e.target.value)}
                style={{ minWidth: 180 }}
              >
                {schoolDepts.length === 0 ? <option value="">No departments</option> : null}
                {schoolDepts.map((d) => (
                  <option key={d.id} value={d.id}>
                    {d.name}
                  </option>
                ))}
              </select>
            </label>
          ) : null}

          <button type="submit" className="btn btn-primary" disabled={busy || institutions.length === 0}>
            Create login and send invite
          </button>
        </form>
      </Card>

      {staffProfiles.length === 0 && pendingInvites.length === 0 ? (
        <Empty
          title="No staff users or pending invites"
          body="Create a staff login above to onboard VC, CoE, Dean, HOD, or Faculty users."
        />
      ) : (
        <Card flush>
          <div style={{ overflowX: 'auto' }}>
            <table style={{ minWidth: 820 }}>
              <thead>
                <tr>
                  <th>Name</th>
                  <th>Email</th>
                  <th>Role</th>
                  <th>Scope</th>
                  <th>Status</th>
                  <th style={{ textAlign: 'right' }}>Action</th>
                </tr>
              </thead>
              <tbody>
                {staffProfiles.map((u) => (
                  <tr key={u.id}>
                    <td style={{ fontWeight: 500 }}>{u.full_name}</td>
                    <td className="mono" style={{ fontSize: 12 }}>
                      {u.email}
                    </td>
                    <td>
                      {(u.roles && u.roles.length > 0 ? u.roles : [u.role])
                        .map((r) => ROLE_LABELS[r])
                        .join(', ')}
                    </td>
                    <td style={{ fontSize: 12, color: 'var(--muted)' }}>
                      {scopeText(u.role, u.institution_id, u.school_id, u.department_id)}
                    </td>
                    <td>
                      <Chip tone={u.active ? 'good' : 'bad'}>{u.active ? 'Active' : 'Disabled'}</Chip>
                    </td>
                    <td style={{ textAlign: 'right' }}>
                      {u.id === currentUserId ? (
                        <span style={{ fontSize: 12, color: 'var(--faint)' }}>You</span>
                      ) : !canManageTarget(currentUserEmail, u.email) ? (
                        <span style={{ fontSize: 12, color: 'var(--faint)' }}>Protected</span>
                      ) : (
                        <div style={{ display: 'inline-flex', gap: 6 }}>
                          <button
                            type="button"
                            className="btn field-sm"
                            disabled={busy}
                            onClick={() => openRoleEditor(u)}
                          >
                            Roles
                          </button>
                          <button
                            type="button"
                            className="btn field-sm"
                            disabled={busy}
                            onClick={() => void toggleActive(u)}
                          >
                            {u.active ? 'Disable' : 'Enable'}
                          </button>
                          <button
                            type="button"
                            className="btn field-sm"
                            disabled={busy}
                            onClick={() => void removeUser(u)}
                          >
                            Remove
                          </button>
                        </div>
                      )}
                    </td>
                  </tr>
                ))}
                {pendingInvites.map((inv) => (
                  <tr key={inv.id}>
                    <td style={{ fontWeight: 500 }}>{inv.full_name}</td>
                    <td className="mono" style={{ fontSize: 12 }}>
                      {inv.email}
                    </td>
                    <td>{ROLE_LABELS[inv.role]}</td>
                    <td style={{ fontSize: 12, color: 'var(--muted)' }}>
                      {scopeText(inv.role, inv.institution_id, inv.school_id, inv.department_id)}
                    </td>
                    <td>
                      <Chip tone="warn">Invited</Chip>
                    </td>
                    <td style={{ textAlign: 'right', color: 'var(--muted)', fontSize: 12 }}>
                      {!canManageTarget(currentUserEmail, inv.email) ? (
                        <span style={{ color: 'var(--faint)' }}>Protected</span>
                      ) : (
                        <button
                          type="button"
                          className="btn field-sm"
                          disabled={busy}
                          onClick={() => void removeInvite(inv)}
                        >
                          Remove
                        </button>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </Card>
      )}

      <div style={{ fontSize: 12, color: 'var(--muted)' }}>
        Students are not created here: faculty onboard them with invitation emails carrying the class code. Currently{' '}
        <span className="mono">{studentCount}</span> students onboarded by{' '}
        <span className="mono">{activeFacultyCount}</span> faculty.
      </div>

      <Modal
        open={Boolean(editingUser)}
        title={editingUser ? `Assign roles · ${editingUser.full_name}` : 'Assign roles'}
        onClose={() => setEditingUser(null)}
      >
        {editingUser ? (
          <form onSubmit={saveUserRoles} style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
            <div className="mono" style={{ fontSize: 12, color: 'var(--muted)' }}>
              {editingUser.email}
            </div>
            <div style={{ display: 'flex', flexWrap: 'wrap', gap: 10 }}>
              {([...STAFF_ROLES, { value: 'super_admin' as UserRole, label: 'Super admin' }]).map((opt) => (
                <label key={opt.value} style={{ display: 'inline-flex', alignItems: 'center', gap: 6, fontSize: 13 }}>
                  <input
                    type="checkbox"
                    checked={editRoles.includes(opt.value)}
                    onChange={() => toggleEditRole(opt.value)}
                  />
                  {opt.label}
                </label>
              ))}
            </div>
            <div className="grid-2">
              <label className="field-label">
                Institution
                <select
                  className="field"
                  value={editInstId}
                  onChange={(e) => {
                    setEditInstId(e.target.value);
                    setEditSchoolId('');
                    setEditDeptId('');
                  }}
                >
                  <option value="">All / none</option>
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
                  value={editSchoolId}
                  onChange={(e) => {
                    setEditSchoolId(e.target.value);
                    setEditDeptId('');
                  }}
                >
                  <option value="">None</option>
                  {schools
                    .filter((s) => !editInstId || s.institution_id === editInstId)
                    .map((s) => (
                      <option key={s.id} value={s.id}>
                        {s.name}
                      </option>
                    ))}
                </select>
              </label>
            </div>
            <label className="field-label">
              Department
              <select
                className="field"
                value={editDeptId}
                onChange={(e) => setEditDeptId(e.target.value)}
              >
                <option value="">None</option>
                {departments
                  .filter(
                    (d) =>
                      (!editInstId || d.institution_id === editInstId) &&
                      (!editSchoolId || d.school_id === editSchoolId),
                  )
                  .map((d) => (
                    <option key={d.id} value={d.id}>
                      {d.code} · {d.name}
                    </option>
                  ))}
              </select>
            </label>
            <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8, marginTop: 4 }}>
              <button type="button" className="btn" onClick={() => setEditingUser(null)}>
                Cancel
              </button>
              <button type="submit" className="btn btn-primary" disabled={busy || editRoles.length === 0}>
                {busy ? 'Saving…' : 'Save roles'}
              </button>
            </div>
          </form>
        ) : null}
      </Modal>
    </div>
  );
}
