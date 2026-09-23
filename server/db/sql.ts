import type { Database } from 'node-sqlite3-wasm'

// node-sqlite3-wasm 的 prepared statement 必须显式 finalize；
// 统一从这里执行一次性 SQL，避免遗漏 finalize 导致 DELETE journal 模式下残留读锁/写锁。
export function sqlAll<T>(db: Database, sql: string, params?: any): T[] {
  const st = db.prepare(sql)
  try {
    return (params === undefined ? st.all() : st.all(params)) as T[]
  } finally {
    st.finalize()
  }
}

export function sqlGet<T>(db: Database, sql: string, params?: any): T | undefined {
  const st = db.prepare(sql)
  try {
    return (params === undefined ? st.get() : st.get(params)) as T | undefined
  } finally {
    st.finalize()
  }
}

export function sqlRun(db: Database, sql: string, params?: any): any {
  const st = db.prepare(sql)
  try {
    return params === undefined ? st.run() : st.run(params)
  } finally {
    st.finalize()
  }
}
