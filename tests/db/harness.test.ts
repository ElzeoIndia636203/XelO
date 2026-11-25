import { describe, expect, it } from 'vitest';
import { as, err, freshDb } from './harness';

describe('DB harness', () => {
  it('boots PGlite and resolves auth.uid() per role', async () => {
    const db = await freshDb();
    const uid = '11111111-1111-1111-1111-111111111111';

    const authed = await as(db, uid, async () => {
      const res = await db.query<{ uid: string | null; role: string }>('SELECT auth.uid() AS uid, current_user AS role');
      return res.rows[0];
    });
    expect(authed?.uid).toBe(uid);
    expect(authed?.role).toBe('authenticated');

    const anon = await as(db, null, async () => {
      const res = await db.query<{ uid: string | null; role: string }>('SELECT auth.uid() AS uid, current_user AS role');
      return res.rows[0];
    });
    expect(anon?.uid).toBeNull();
    expect(anon?.role).toBe('anon');

    const msg = await err(Promise.reject(new Error('forbidden')));
    expect(msg).toBe('forbidden');
  });
});
