export interface LatestRequestTicket<Key> {
  key: Key
  sequence: number
}

export interface LatestRequestGuard<Key> {
  begin: (key: Key) => LatestRequestTicket<Key>
  isCurrent: (ticket: LatestRequestTicket<Key>, currentKey: Key) => boolean
  invalidate: () => void
}

export function createLatestRequestGuard<Key>(): LatestRequestGuard<Key> {
  let sequence = 0
  return {
    begin: key => ({ key, sequence: ++sequence }),
    isCurrent: (ticket, currentKey) => ticket.sequence === sequence && Object.is(ticket.key, currentKey),
    invalidate: () => { sequence += 1 },
  }
}
