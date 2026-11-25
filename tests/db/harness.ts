import { PGlite } from '@electric-sql/pglite';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

export async function freshDb(): Promise<PGlite> {
  const db = new PGlite();

  await db.exec(`
    DO $$
    BEGIN
      IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'anon') THEN
        CREATE ROLE anon NOLOGIN;
      END IF;
      IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'authenticated') THEN
        CREATE ROLE authenticated NOLOGIN;
      END IF;
      IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'service_role') THEN
        CREATE ROLE service_role NOLOGIN BYPASSRLS;
      END IF;
    END $$;

    CREATE SCHEMA IF NOT EXISTS auth;
    CREATE SCHEMA IF NOT EXISTS storage;

    CREATE TABLE IF NOT EXISTS auth.users (
      id uuid PRIMARY KEY,
      email text UNIQUE NOT NULL,
      raw_user_meta_data jsonb NOT NULL DEFAULT '{}'::jsonb,
      created_at timestamptz NOT NULL DEFAULT now()
    );

    CREATE OR REPLACE FUNCTION auth.uid()
    RETURNS uuid
    LANGUAGE sql
    STABLE
    AS $$
      SELECT NULLIF(current_setting('request.jwt.claim.sub', true), '')::uuid;
    $$;

    CREATE OR REPLACE FUNCTION auth.role()
    RETURNS text
    LANGUAGE sql
    STABLE
    AS $$
      SELECT COALESCE(NULLIF(current_setting('request.jwt.claim.role', true), ''), current_user::text);
    $$;

    GRANT USAGE ON SCHEMA public TO anon, authenticated, service_role;
    GRANT USAGE ON SCHEMA auth TO anon, authenticated, service_role;
    ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT ALL ON TABLES TO authenticated, service_role;
    ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT EXECUTE ON FUNCTIONS TO anon, authenticated, service_role;
  `);

  const migrationsDir = resolve(process.cwd(), 'supabase/migrations');
  if (existsSync(migrationsDir)) {
    const files = readdirSync(migrationsDir)
      .filter((f) => f.endsWith('.sql'))
      .sort();
    for (const file of files) {
      const sql = readFileSync(join(migrationsDir, file), 'utf8');
      if (sql.trim()) {
        await db.exec(sql);
      }
    }
  }

  return db;
}

export async function as<T>(
  db: PGlite,
  uid: string | null,
  fn: () => Promise<T>,
  role: 'anon' | 'authenticated' | 'service_role' = uid ? 'authenticated' : 'anon',
): Promise<T> {
  await db.exec(`BEGIN; SET LOCAL ROLE ${role};`);
  await db.query(`SELECT set_config('request.jwt.claim.sub', $1, true)`, [uid ?? '']);
  await db.query(`SELECT set_config('request.jwt.claim.role', $1, true)`, [role]);
  try {
    const result = await fn();
    await db.exec('COMMIT;');
    return result;
  } catch (e) {
    await db.exec('ROLLBACK;');
    throw e;
  }
}

export async function err(promise: Promise<unknown>): Promise<string> {
  try {
    await promise;
  } catch (e) {
    return e instanceof Error ? e.message : String(e);
  }
  throw new Error('Expected promise to reject, but it resolved');
}
