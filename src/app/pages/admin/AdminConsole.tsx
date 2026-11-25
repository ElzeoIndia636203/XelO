import { useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { Banner, ErrorNote, Loading, PageHead } from '../../../components/ui';
import { useLoad } from '../../../lib/hooks';
import { useSession } from '../../../lib/session';
import { fetchAll, rpc, supabase } from '../../../lib/supabase';
import type {
  AiUsageReportRow,
  AuditFeedRow,
  Department,
  Institution,
  Invite,
  Plan,
  Profile,
  School,
  SubscriptionRequest,
} from '../../../lib/types';
import { ConsoleShell, type NavItem } from '../../components/ConsoleShell';
import { RolePortalToggle } from '../../components/RolePortalToggle';
import { AuditTab } from './AuditTab';
import { CreditsTab } from './CreditsTab';
import { InstitutionsTab } from './InstitutionsTab';
import { SubscriptionsTab } from './SubscriptionsTab';
import { UsersTab } from './UsersTab';

type AdminTab = 'users' | 'institutions' | 'subs' | 'credits' | 'audit';

const TAB_META: Record<AdminTab, { title: string; lead: string }> = {
  users: {
    title: 'Users and roles',
    lead: 'Create logins and map emails for VC, CoE, deans, HODs and faculty',
  },
  institutions: {
    title: 'Institutions',
    lead: 'Institutions, schools, departments and active plans',
  },
  subs: {
    title: 'Subscriptions',
    lead: 'Plans and AI limits; requests approved manually with a duration',
  },
  credits: {
    title: 'AI credits',
    lead: 'Usage per faculty against their subscription caps',
  },
  audit: {
    title: 'Audit log',
    lead: 'Every change made in this console',
  },
};

type CourseProgrammeRow = {
  id: string;
  institution_id: string;
  department_id: string | null;
  programme: string;
};

export function AdminConsole() {
  const { profile, signOut } = useSession();
  const [params, setParams] = useSearchParams();
  const rawTab = params.get('tab') as AdminTab | null;
  const tab: AdminTab = rawTab && rawTab in TAB_META ? rawTab : 'users';
  const [notice, setNotice] = useState<{ text: string; ok: boolean } | null>(null);

  const { data, loading, error, reload } = useLoad(async () => {
    const [institutions, schools, departments, profiles, invites, plans, requests, credits, audit, courses] =
      await Promise.all([
        fetchAll<Institution>((from, to) =>
          supabase.from('institutions').select('*').order('name').range(from, to),
        ),
        fetchAll<School>((from, to) =>
          supabase.from('schools').select('*').order('name').range(from, to),
        ),
        fetchAll<Department>((from, to) =>
          supabase.from('departments').select('*').order('name').range(from, to),
        ),
        fetchAll<Profile>((from, to) =>
          supabase.from('profiles').select('*').order('full_name').range(from, to),
        ),
        fetchAll<Invite>((from, to) =>
          supabase.from('invites').select('*').order('created_at', { ascending: false }).range(from, to),
        ),
        supabase
          .from('plans')
          .select('*')
          .order('tier')
          .then((r) => {
            if (r.error) throw new Error(r.error.message);
            return (r.data ?? []) as Plan[];
          }),
        fetchAll<SubscriptionRequest>((from, to) =>
          supabase
            .from('subscription_requests')
            .select('*')
            .order('created_at', { ascending: false })
            .range(from, to),
        ),
        rpc<AiUsageReportRow[]>('ai_usage_report'),
        rpc<AuditFeedRow[]>('admin_audit_feed', { p_limit: 200 }),
        fetchAll<CourseProgrammeRow>((from, to) =>
          supabase.from('courses').select('id, institution_id, department_id, programme').range(from, to),
        ).catch(() => [] as CourseProgrammeRow[]),
      ]);

    return {
      institutions,
      schools,
      departments,
      profiles,
      invites,
      plans,
      requests,
      credits: credits ?? [],
      audit: audit ?? [],
      courses,
    };
  }, []);

  const pendingSubs = data?.requests.filter((r) => r.status === 'sent').length ?? 0;
  const navItems: NavItem[] = [
    { id: 'users', label: 'Users and roles' },
    { id: 'institutions', label: 'Institutions' },
    { id: 'subs', label: 'Subscriptions', badge: pendingSubs },
    { id: 'credits', label: 'AI credits' },
    { id: 'audit', label: 'Audit log' },
  ];

  function selectTab(next: string) {
    setNotice(null);
    setParams({ tab: next });
  }

  function notify(text: string, ok: boolean) {
    setNotice({ text, ok });
  }

  const meta = TAB_META[tab];

  return (
    <ConsoleShell
      roleTitle="Super admin"
      scopeText={`All rights · ${data?.institutions.length ?? 0} institutions`}
      navItems={navItems}
      activeTab={tab}
      onTabChange={selectTab}
      userEmail={profile?.email ?? ''}
      topbarExtra={<RolePortalToggle active="admin" />}
      onSignOut={() => void signOut()}
    >
      <PageHead title={meta.title} lead={meta.lead} />

      {notice ? <Banner tone={notice.ok ? 'ok' : 'err'}>{notice.text}</Banner> : null}
      {error ? <ErrorNote message={error} /> : null}
      {loading && !data ? <Loading /> : null}

      {data && profile ? (
        <>
          {tab === 'users' ? (
            <UsersTab
              currentUserId={profile.id}
              currentUserEmail={profile.email}
              institutions={data.institutions}
              schools={data.schools}
              departments={data.departments}
              profiles={data.profiles}
              invites={data.invites}
              onNotify={notify}
              onRefresh={async () => {
                reload();
              }}
            />
          ) : null}

          {tab === 'institutions' ? (
            <InstitutionsTab
              institutions={data.institutions}
              schools={data.schools}
              departments={data.departments}
              courses={data.courses}
              onNotify={notify}
              onRefresh={async () => {
                reload();
              }}
            />
          ) : null}

          {tab === 'subs' ? (
            <SubscriptionsTab
              institutions={data.institutions}
              departments={data.departments}
              courses={data.courses}
              profiles={data.profiles}
              plans={data.plans}
              requests={data.requests}
              onNotify={notify}
              onRefresh={async () => {
                reload();
              }}
            />
          ) : null}

          {tab === 'credits' ? (
            <CreditsTab
              rows={data.credits}
              onNotify={notify}
              onRefresh={async () => {
                reload();
              }}
            />
          ) : null}

          {tab === 'audit' ? (
            <AuditTab rows={data.audit} institutions={data.institutions} />
          ) : null}
        </>
      ) : null}
    </ConsoleShell>
  );
}

export default AdminConsole;
