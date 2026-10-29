import pg from 'pg';
import { readFileSync, readdirSync } from 'fs';
const conn = "postgresql://postgres.ngpisavfwixwxmwsllak:12345678BA4GWUSJ7@aws-1-ap-southeast-2.pooler.supabase.com:5432/postgres";
const client = new pg.Client({ connectionString: conn, ssl: { rejectUnauthorized: false } });
await client.connect();
await client.query('CREATE TABLE IF NOT EXISTS _folk_migrations (filename TEXT PRIMARY KEY, applied_at TIMESTAMPTZ DEFAULT now())');
const { rows } = await client.query('SELECT filename FROM _folk_migrations');
const applied = new Set(rows.map(r => r.filename));
const files = readdirSync('migrations').filter(f => f.endsWith('.sql')).sort();
let done = 0;
for (const f of files) {
  if (applied.has(f)) continue;
  try {
    await client.query(readFileSync(`migrations/${f}`, 'utf8'));
    await client.query('INSERT INTO _folk_migrations (filename) VALUES ($1)', [f]);
    console.log('OK', f); done++;
  } catch (e) {
    console.error('FAIL', f, String(e).slice(0, 250));
    break;
  }
}
const fin = await client.query('SELECT count(*) FROM _folk_migrations');
console.log(`DONE applied_now=${done} total_in_table=${fin.rows[0].count}`);
await client.end();
