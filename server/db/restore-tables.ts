import type { Database, NormalQueryResult } from 'node-sqlite3-wasm'
import { sqlAll, sqlGet, sqlRun } from './sql'

const PRESERVED_SCHEMA_TABLES = new Set(['module_migrations', 'filesystem_operation_history', 'folder_move_jobs'])

function quoteIdentifier(value: string): string {
  return `"${value.replace(/"/g, '""')}"`
}

interface TableColumnInfo {
  name: string
  pk: number
}

function tableColumnInfo(db: Database, schema: string, table: string): TableColumnInfo[] {
  return sqlAll<TableColumnInfo>(
    db,
    'SELECT name, pk FROM pragma_table_info(?, ?) ORDER BY cid',
    [table, schema],
  )
}

function tableColumns(db: Database, schema: string, table: string): string[] {
  return tableColumnInfo(db, schema, table).map(column => column.name)
}

function singlePrimaryKeyColumn(db: Database, schema: string, table: string): string | undefined {
  const primaryKey = tableColumnInfo(db, schema, table).filter(column => Number(column.pk) > 0)
  return primaryKey.length === 1 ? primaryKey[0].name : undefined
}

export interface RestoreAttachedTablesResult {
  tables: number
  rows: number
}

export function restoreDatabaseTables(db: Database, source: Database): RestoreAttachedTablesResult {
  const currentTables = sqlAll<{ name: string }>(
    db,
    "SELECT name FROM main.sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'",
  )
  const sourceTables = new Set(sqlAll<{ name: string }>(
    source,
    "SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'",
  ).map(table => table.name))
  let rows = 0

  // Clear the complete mutable graph before copying any backup rows. Foreign-key
  // deferral postpones validation, but ON DELETE CASCADE/SET NULL actions still
  // run immediately and could otherwise mutate children restored earlier.
  for (const { name } of currentTables) {
    if (PRESERVED_SCHEMA_TABLES.has(name)) continue
    sqlRun(db, `DELETE FROM ${quoteIdentifier(name)}`)
  }

  for (const { name } of currentTables) {
    if (PRESERVED_SCHEMA_TABLES.has(name) || !sourceTables.has(name)) continue
    const tableSql = quoteIdentifier(name)
    const sourceColumnSet = new Set(tableColumns(source, 'main', name))
    const sharedColumns = tableColumns(db, 'main', name).filter(column => sourceColumnSet.has(column))
    if (sharedColumns.length === 0) continue
    const columnsSql = sharedColumns.map(quoteIdentifier).join(', ')
    const insert = db.prepare(`INSERT INTO ${tableSql} (${columnsSql}) VALUES (${sharedColumns.map(() => '?').join(', ')})`)
    const select = source.prepare(`SELECT ${columnsSql} FROM ${tableSql}`)
    try {
      for (const row of select.iterate()) {
        // iterate() uses flat rows unless expand is explicitly enabled.
        const values = row as NormalQueryResult
        insert.run(sharedColumns.map(column => values[column]))
      }
    } finally { select.finalize(); insert.finalize() }
    rows += Number(sqlGet<{ count: number }>(db, `SELECT COUNT(*) AS count FROM ${tableSql}`)?.count ?? 0)
  }

  const sequences = sqlAll<{ name: string }>(db, 'SELECT name FROM sqlite_sequence')
  for (const { name } of sequences) {
    const primaryKey = singlePrimaryKeyColumn(db, 'main', name)
    if (!primaryKey) continue
    const tableSql = quoteIdentifier(name)
    const primaryKeySql = quoteIdentifier(primaryKey)
    const maximum = sqlGet<{ value: number | null }>(db, `SELECT MAX(${primaryKeySql}) AS value FROM ${tableSql}`)
    sqlRun(db, 'UPDATE sqlite_sequence SET seq = ? WHERE name = ?', [maximum?.value ?? 0, name])
  }

  return { tables: currentTables.length, rows }
}


