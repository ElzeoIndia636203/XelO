import { useEffect, useState } from 'react';
import { Card, Chip } from '../../components/ui';
import { formatDateTimeIst } from '../../lib/format';
import { supabase } from '../../lib/supabase';

interface SharedLoop {
  id: string;
  course_id: string;
  co_code: string;
  title: string;
  hod_remarks: string;
  shared_at: string | null;
}

export function FeedbackInsightsCard() {
  const [rows, setRows] = useState<SharedLoop[]>([]);

  useEffect(() => {
    void (async () => {
      const { data } = await supabase
        .from('feedback_loops')
        .select('id, course_id, co_code, title, hod_remarks, shared_at')
        .eq('status', 'closed')
        .not('shared_at', 'is', null)
        .order('shared_at', { ascending: false })
        .limit(10);
      setRows((data ?? []) as SharedLoop[]);
    })();
  }, []);

  if (rows.length === 0) return null;

  return (
    <Card title="Shared CO feedback insights & HoD remarks">
      <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
        {rows.map((r) => (
          <div
            key={r.id}
            style={{
              padding: 12,
              border: '1px solid var(--border)',
              borderRadius: 6,
              background: 'var(--surface)',
              display: 'flex',
              flexDirection: 'column',
              gap: 4,
            }}
          >
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 8 }}>
              <span style={{ fontWeight: 600, fontSize: 13 }}>{r.title}</span>
              <Chip tone="good">{r.co_code}</Chip>
            </div>
            <div style={{ fontSize: 13 }}>
              <strong>HoD Remarks:</strong> {r.hod_remarks}
            </div>
            {r.shared_at && (
              <div className="mono" style={{ fontSize: 11, color: 'var(--muted)' }}>
                Shared {formatDateTimeIst(r.shared_at)}
              </div>
            )}
          </div>
        ))}
      </div>
    </Card>
  );
}
