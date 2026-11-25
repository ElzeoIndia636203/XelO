import { Empty, PageHead } from '../../../components/ui';
import { StudentShell, type StudentTabId } from './StudentShell';

export function StudentTabPlaceholder({ tab }: { tab: Extract<StudentTabId, 'endsem'> }) {
  return (
    <StudentShell activeTab={tab}>
      <PageHead
        kicker="PRACTICAL EXAMINATION"
        title="End-sem practical"
        lead="End-sem assessment schedule, secure check, and results open in Phase 7."
      />
      <Empty
        title="End-sem practical arrives in Phase 7"
        body="End-sem assessment schedule, secure check, and results open in Phase 7."
      />
    </StudentShell>
  );
}
