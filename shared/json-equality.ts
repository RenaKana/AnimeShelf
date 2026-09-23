export function sameJson(left: unknown, right: unknown): boolean {
  if (Object.is(left, right)) return true
  if (!left || !right || typeof left !== 'object' || typeof right !== 'object') return false
  if (Array.isArray(left) !== Array.isArray(right)) return false
  const a = Object.keys(left).sort(), b = Object.keys(right).sort()
  return a.length === b.length && a.every((key, index) => key === b[index]
    && sameJson((left as Record<string, unknown>)[key], (right as Record<string, unknown>)[key]))
}
