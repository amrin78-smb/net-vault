import { Pool } from 'pg'

const connectionString = process.env.DATABASE_URL

const pool = new Pool({
  connectionString,
  ssl: connectionString?.includes('localhost') || connectionString?.includes('127.0.0.1')
    ? false
    : { rejectUnauthorized: false }
})

export async function query(text: string, params?: any[]) {
  const client = await pool.connect()
  try {
    const result = await client.query(text, params)
    return result
  } finally {
    client.release()
  }
}

export default pool
