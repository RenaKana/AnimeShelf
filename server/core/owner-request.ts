import type { Request } from 'express'
import { isLocalOrigin, isLoopbackAddress, isLoopbackHost } from './local-origin'

/** Same local-owner boundary as external-access management; bearer tokens never grant owner access. */
export function isOwnerRequest(req: Request): boolean {
  const peer = req.socket.remoteAddress ?? ''
  if (!isLoopbackAddress(peer) || req.headers.authorization !== undefined) return false
  try {
    if (!isLoopbackHost(req.get('host') ?? '') || !isLocalOrigin(req.get('origin'))) return false
    return ['GET', 'HEAD'].includes(req.method) || req.get('X-AnimeShelf-Owner') === '1'
  } catch { return false }
}
