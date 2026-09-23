import type { Request, RequestHandler, Response, Router } from 'express'
import type { Database } from 'node-sqlite3-wasm'
import type { ExternalApiRole } from '../../shared/external-api'

export type ExternalApiRequiredRole = Exclude<ExternalApiRole, 'disabled'>
export type ExternalApiJsonObject = Record<string, unknown>
export type ExternalApiSqlValue = boolean | number | bigint | string | Uint8Array | null
export type ExternalApiRouteHandler = (req: Request, res: Response) => unknown | Promise<unknown>

export interface ExternalApiCatalogSnapshot {
  entries: unknown[]
  summary: unknown | null
  canonical?: unknown | null
  candidates?: unknown[]
}

export interface ExternalApiRouteFactoryContext {
  db: Database
  auth: {
    withRole: (required: ExternalApiRequiredRole, handler: ExternalApiRouteHandler) => RequestHandler
  }
  audit: {
    /** Tracks asynchronous route work so listener draining and the host audit lifecycle observe completion. */
    track: (handler: ExternalApiRouteHandler) => RequestHandler
  }
  input: {
    plainBody: (req: Request) => ExternalApiJsonObject
    assertKeys: (value: ExternalApiJsonObject, allowed: readonly string[]) => void
    assertQueryKeys: (req: Request, allowed: readonly string[]) => void
    queryString: (req: Request, key: string) => string | undefined
    positiveInteger: (value: unknown, label: string, code?: string) => number
    boundedInteger: (value: unknown, label: string, min: number, max: number) => number
    nullableBoundedInteger: (value: unknown, label: string, min: number, max: number) => number | null
    nullableNumber: (value: unknown, label: string, min: number, max: number) => number | null
    limitedString: (value: unknown, label: string, max: number, options?: { nullable?: boolean; empty?: boolean }) => string | null
    pagination: (req: Request) => { page: number; pageSize: number; offset: number }
    listResponse: <T>(data: T[], page: number, pageSize: number, total: number) => { data: T[]; pagination: { page: number; pageSize: number; total: number } }
    escapedLike: (value: string) => string
    parseJsonArray: (value: unknown) => unknown[]
  }
  errors: {
    create: (message: string, status: number, code: string) => Error
    send: (res: Response, status: number, error: string, code: string) => Response
    handle: (error: unknown, res: Response) => Response
  }
  responses: {
    catalog: (catalog: ExternalApiCatalogSnapshot) => {
      media_catalog: unknown[]
      media_catalog_summary: unknown | null
      media_catalog_v2: unknown | null | undefined
      media_catalog_candidates: unknown[] | undefined
    }
  }
  cache: {
    invalidateLibraryMatches: () => void
  }
}

export interface ExternalApiRouteContribution {
  /** Stable module identity; runtime contribution ownership is intentionally not exposed to consumers. */
  moduleId: string
  createRouter: (context: ExternalApiRouteFactoryContext) => Router
}
