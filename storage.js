/*
 * Where the board is stored. Two backends behind one tiny interface:
 *
 *   file      data/board.json — zero setup, one machine. The default.
 *   postgres  one row in Postgres — survives Replit redeploys, and lets your
 *             local machine and the deployed app share ONE database.
 *
 * Selection (first match wins):
 *   BOARD_STORE=file        → file, always
 *   BOARD_STORE=postgres    → postgres (errors if DATABASE_URL is missing)
 *   DATABASE_URL is set     → postgres
 *   otherwise               → file
 *
 * There is deliberately no automatic fallback from postgres to file: if you
 * asked for the database and it can't be reached, that's an error to fix, not
 * a reason to silently start writing to a throwaway local file.
 *
 * The interface is just load() / save(doc) / close(). The whole board is one
 * JSON document; the server keeps it in memory and calls save() (debounced)
 * after each change, exactly as it did with the plain file.
 */

import fsp from 'node:fs/promises';
import path from 'node:path';

export async function createStore(env, { dataFile }) {
  const choice = String(env.BOARD_STORE || '').toLowerCase();
  const url = (env.DATABASE_URL || '').trim();

  if (choice === 'file') return new FileStore(dataFile);
  if (choice === 'postgres') {
    if (!url) throw new Error('BOARD_STORE=postgres but DATABASE_URL is not set');
    return new PostgresStore(url);
  }
  if (url) return new PostgresStore(url);
  return new FileStore(dataFile);
}

/* ------------------------------------------------------------------ file */

class FileStore {
  constructor(dataFile) {
    this.dataFile = dataFile;
    this.name = 'file';
    this.describe = `file (${path.basename(dataFile)})`;
  }

  // Returns the stored board, or null when the store is empty (caller seeds).
  async load() {
    let raw;
    try {
      raw = await fsp.readFile(this.dataFile, 'utf8');
    } catch (err) {
      if (err.code === 'ENOENT') return null;
      throw err;
    }
    try {
      return JSON.parse(raw);
    } catch (err) {
      // The file exists but is unreadable. Never reseed over it — that would
      // destroy real work. Set it aside and make the server refuse to start.
      const aside = `${this.dataFile}.corrupt-${new Date().toISOString().replace(/[:.]/g, '-')}`;
      await fsp.rename(this.dataFile, aside);
      const e = new Error(`${path.basename(this.dataFile)} is not valid JSON (${err.message}); preserved at ${aside}`);
      e.fatal = true;
      throw e;
    }
  }

  async save(doc) {
    await fsp.mkdir(path.dirname(this.dataFile), { recursive: true });
    const tmp = `${this.dataFile}.${process.pid}.tmp`;
    await fsp.writeFile(tmp, JSON.stringify(doc, null, 2));
    await fsp.rename(tmp, this.dataFile); // atomic replace
  }

  async close() {}
}

/* -------------------------------------------------------------- postgres */

const ROW_ID = 'main';

class PostgresStore {
  constructor(url) {
    this.url = url;
    this.name = 'postgres';
    this.describe = 'postgres';
    this.sql = null;
  }

  async connect() {
    if (this.sql) return this.sql;

    // Loaded lazily so a clone with no DATABASE_URL never needs `npm install`.
    let postgres;
    try {
      ({ default: postgres } = await import('postgres'));
    } catch {
      throw new Error("DATABASE_URL is set but the 'postgres' package isn't installed — run: npm install");
    }

    // Managed Postgres (Replit, Neon, Supabase, RDS…) requires TLS; a plain
    // local/Helium server does not and rejects it. Decide from the URL.
    const wantsSsl = /sslmode=require|neon\.tech|supabase|render\.com|amazonaws\.com|replit/i.test(this.url);
    this.sql = postgres(this.url, {
      max: 3,
      idle_timeout: 20,
      connect_timeout: 15,
      ssl: wantsSsl ? 'require' : false,
      prepare: !/pgbouncer=true|pooler\./i.test(this.url),
      onnotice: () => {},
    });

    await this.sql`
      create table if not exists board (
        id text primary key,
        doc jsonb not null,
        rev integer not null default 1,
        updated_at timestamptz not null default now()
      )
    `;
    return this.sql;
  }

  async load() {
    const sql = await this.connect();
    const rows = await sql`select doc from board where id = ${ROW_ID}`;
    return rows.length ? rows[0].doc : null;
  }

  async save(doc) {
    const sql = await this.connect();
    await sql`
      insert into board (id, doc, rev, updated_at)
      values (${ROW_ID}, ${sql.json(doc)}, 1, now())
      on conflict (id) do update
        set doc = excluded.doc, rev = board.rev + 1, updated_at = now()
    `;
  }

  async close() {
    if (this.sql) await this.sql.end({ timeout: 5 });
  }
}
