// NocVault Hub — cross-app read layer.
// Opens a read-only connection pool per suite database using the dedicated
// `nocvault_readonly` role (SELECT-only). This is how the Hub correlates data
// across NetVault / LogVault / DDIVault / SpanVault WITHOUT coupling to each
// app's own DB user. Credentials come from env (set by the installer / .env.local):
//   NOCVAULT_RO_HOST (default 127.0.0.1), NOCVAULT_RO_PORT (default 5432),
//   NOCVAULT_RO_USER (default nocvault_readonly), NOCVAULT_RO_PASS
// If the creds are missing or any query fails, every call degrades to `null`
// so the launcher never breaks before the role is configured on a given server.
import { Pool } from 'pg';

export type SuiteDb = 'netvault' | 'logvault' | 'ddivault' | 'spanvault';

const pools: Partial<Record<SuiteDb, Pool>> = {};

export function suiteReadConfigured(): boolean {
  return !!process.env.NOCVAULT_RO_PASS;
}

function getPool(db: SuiteDb): Pool | null {
  if (!suiteReadConfigured()) return null;
  if (!pools[db]) {
    const p = new Pool({
      // 127.0.0.1, not 'localhost': the suite rule is that server-side local
      // connections use the literal IPv4 address, because on Windows localhost
      // resolves ::1 first and these apps listen on IPv4 only. The sibling
      // health probe in app/api/suite/health already hardcodes 127.0.0.1; this
      // default was simply missed.
      host: process.env.NOCVAULT_RO_HOST || '127.0.0.1',
      port: parseInt(process.env.NOCVAULT_RO_PORT || '5432', 10),
      user: process.env.NOCVAULT_RO_USER || 'nocvault_readonly',
      password: process.env.NOCVAULT_RO_PASS,
      database: db,
      ssl: false,
      max: 4,
      idleTimeoutMillis: 30_000,
      connectionTimeoutMillis: 6_000,
      statement_timeout: 8_000,
    });
    // Swallow idle-client errors so a transient drop can never crash the process.
    p.on('error', () => {});
    pools[db] = p;
  }
  return pools[db]!;
}

// SELECT-only query against a suite DB. Returns rows, or null on ANY failure
// (creds absent, connection error, query error) — never throws to the caller.
export async function queryDb<T = Record<string, unknown>>(
  db: SuiteDb,
  sql: string,
  params: unknown[] = [],
): Promise<T[] | null> {
  const pool = getPool(db);
  if (!pool) return null;
  try {
    const r = await pool.query(sql, params);
    return r.rows as T[];
  } catch {
    return null;
  }
}

// Convenience: run a scalar query and return the first row, or null.
export async function queryOne<T = Record<string, unknown>>(
  db: SuiteDb,
  sql: string,
  params: unknown[] = [],
): Promise<T | null> {
  const rows = await queryDb<T>(db, sql, params);
  return rows && rows.length ? rows[0] : null;
}
