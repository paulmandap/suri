import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  MIGRATIONS,
  NewerDatabaseError,
  isDamaged,
  migrate,
  openDatabase,
  transaction
} from '../src/main/db'
import { HISTORY_FILE, openHistory } from '../src/main/history'

let dir: string
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'suri-db-'))
})
afterEach(() => {
  rmSync(dir, { recursive: true, force: true })
})

const tables = (db: DatabaseSync): string[] =>
  (
    db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name").all() as {
      name: string
    }[]
  ).map((row) => row.name)

describe('openDatabase', () => {
  it('creates the schema on first open, in WAL mode', () => {
    const db = openDatabase(join(dir, 'sub', 'history.db'))
    expect(tables(db)).toEqual(['decisions', 'digests', 'steps', 'turns'])
    expect((db.prepare('PRAGMA user_version').get() as { user_version: number }).user_version).toBe(
      MIGRATIONS.length
    )
    expect((db.prepare('PRAGMA journal_mode').get() as { journal_mode: string }).journal_mode).toBe(
      'wal'
    )
    db.close()
  })

  it('opens an up-to-date file again without touching it', () => {
    const file = join(dir, 'history.db')
    const first = openDatabase(file)
    first.exec("INSERT INTO digests (day, digest, created_at) VALUES ('2026-10-07', '{}', 1)")
    first.close()
    const again = openDatabase(file)
    expect(again.prepare('SELECT COUNT(*) AS n FROM digests').get()).toEqual({ n: 1 })
    again.close()
  })

  it("refuses a newer Suri's file instead of guessing at its schema", () => {
    const file = join(dir, 'history.db')
    const db = new DatabaseSync(file)
    db.exec(`PRAGMA user_version = ${MIGRATIONS.length + 1}`)
    db.close()
    expect(() => openDatabase(file)).toThrow(NewerDatabaseError)
  })

  it('reports a file that is not a database as damaged', () => {
    const file = join(dir, 'history.db')
    writeFileSync(file, 'not a database '.repeat(40))
    let caught: unknown
    try {
      openDatabase(file)
    } catch (err) {
      caught = err
    }
    expect(isDamaged(caught)).toBe(true)
    expect(isDamaged(new Error('busy'))).toBe(false)
  })
})

describe('migrate', () => {
  it('rolls a failed step back, leaving the version where it was', () => {
    const db = new DatabaseSync(':memory:')
    db.exec('CREATE TABLE turns (id INTEGER)') // the first migration will clash with this
    expect(() => migrate(db)).toThrow()
    expect((db.prepare('PRAGMA user_version').get() as { user_version: number }).user_version).toBe(
      0
    )
    db.close()
  })
})

describe('transaction', () => {
  it('commits on success and rolls back on a throw', () => {
    const db = new DatabaseSync(':memory:')
    db.exec('CREATE TABLE t (v INTEGER)')
    transaction(db, () => db.exec('INSERT INTO t VALUES (1)'))
    expect(() =>
      transaction(db, () => {
        db.exec('INSERT INTO t VALUES (2)')
        throw new Error('stop')
      })
    ).toThrow('stop')
    expect(db.prepare('SELECT v FROM t').all()).toEqual([{ v: 1 }])
    // A nested call joins the open transaction.
    transaction(db, () => transaction(db, () => db.exec('INSERT INTO t VALUES (3)')))
    expect(db.prepare('SELECT COUNT(*) AS n FROM t').get()).toEqual({ n: 2 })
    db.close()
  })
})

describe('openHistory', () => {
  it('moves a damaged file aside and starts a new history', () => {
    const file = join(dir, HISTORY_FILE)
    writeFileSync(file, 'not a database '.repeat(40))
    const logs: string[] = []
    const opened = openHistory(dir, { log: (line) => logs.push(line) })
    expect(opened.ok).toBe(true)
    if (opened.ok) opened.history.close()
    const aside = readdirSync(dir).filter((name) => name.startsWith(`${HISTORY_FILE}.bad-`))
    expect(aside).toHaveLength(1)
    expect(readFileSync(join(dir, aside[0]!), 'utf8')).toContain('not a database')
    expect(logs.join('\n')).toMatch(/moved aside/)
  })

  it("leaves a newer Suri's file alone and says why", () => {
    const db = new DatabaseSync(join(dir, HISTORY_FILE))
    db.exec(`PRAGMA user_version = ${MIGRATIONS.length + 5}`)
    db.close()
    const opened = openHistory(dir)
    expect(opened).toEqual({ ok: false, message: expect.stringMatching(/newer Suri/) })
    expect(existsSync(join(dir, HISTORY_FILE))).toBe(true)
    expect(readdirSync(dir).some((name) => name.includes('.bad-'))).toBe(false)
  })
})
