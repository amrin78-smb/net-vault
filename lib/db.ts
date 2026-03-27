import { Pool } from 'pg'

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

export default pool
