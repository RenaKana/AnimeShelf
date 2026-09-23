export function isLoopbackAddress(value: string): boolean {
  const address = value.toLowerCase()
  return address === '127.0.0.1' || address === '::1' || address.startsWith('::ffff:127.')
}

export function isLoopbackHost(host: string): boolean {
  return /^(localhost|127\.0\.0\.1|\[::1\])(?::\d{1,5})?$/i.test(host)
}

export function isLocalOrigin(origin: string | undefined): boolean {
  if (!origin) return true
  try {
    const url = new URL(origin)
    return ['http:', 'https:'].includes(url.protocol)
      && !url.username && !url.password
      && isLoopbackHost(url.host)
  } catch {
    return false
  }
}
