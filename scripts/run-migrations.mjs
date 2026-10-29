import pg from 'pg';
import { readFileSync, readdirSync, existsSync } from 'fs';
const conn = process.env.APP_DATABASE_URL || process.env.DATABASE_URL;
if (!conn) { console.error('no DATABASE_URL'); process.exit(1); }
const client = new pg.Client({ connectionString: conn, ssl: { rejectUnauthorized: false } });
await client.connect();
await client.query('CREATE TABLE IF NOT EXISTS _folk_migrations (filename TEXT PRIMARY KEY, applied_at TIMESTAMPTZ DEFAULT now())');
const { rows } = await client.query('SELECT filename FROM _folk_migrations');
const applied = new Set(rows.map(r => r.filename));
const dir = 'migrations';
const files = readdirSync(dir).filter(f => f.endsWith('.sql')).sort();
let done = 0;
for (const f of files) {
  if (applied.has(f)) continue;
  try {
    const sql = readFileSync(`${dir}/${f}`, 'utf8');
    await client.query(sql);
    await client.query('INSERT INTO _folk_migrations (filename) VALUES ($1)', [f]);
    console.log('OK', f);
    done++;
  } catch (e) {
    console.error('FAIL', f, String(e).slice(0, 300));
    process.exit(1);
  }
}
const fin = await client.query('SELECT count(*) FROM _folk_migrations');
console.log(`DONE applied_now=${done} total_in_table=${fin.rows[0].count}`);
await client.end();
