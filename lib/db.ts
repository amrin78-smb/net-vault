import { Pool, PoolClient } from 'pg'

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.SSL_DISABLED === 'true' ? false : { rejectUnauthorized: false },
  max: 10,
})

export async function query(text: string, params?: unknown[]) {
  const client = await pool.connect()
  try {
    const res = await client.query(text, params)
    return res
  } finally {
    client.release()
  }
}

// Run `fn` on a single dedicated connection inside BEGIN/COMMIT (ROLLBACK on
// throw). Use this when several statements must be atomic — every statement
// inside MUST use the passed client (a stray top-level query() runs on a
// DIFFERENT pooled connection, outside the transaction, and won't roll back).
export async function withTransaction<T>(fn: (client: PoolClient) => Promise<T>): Promise<T> {
  const client = await pool.connect()
  try {
    await client.query('BEGIN')
    const result = await fn(client)
    await client.query('COMMIT')
    return result
  } catch (e) {
    await client.query('ROLLBACK').catch(() => {})
    throw e
  } finally {
    client.release()
  }
}

export default pool
