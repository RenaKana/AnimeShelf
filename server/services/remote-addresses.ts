import { isIP } from 'node:net'

const IPV4_UNSAFE: ReadonlyArray<readonly [number, number]> = [
  [0x00000000, 0x00ffffff],
  [0x0a000000, 0x0affffff],
  [0x64400000, 0x647fffff],
  [0x7f000000, 0x7fffffff],
  [0xa9fe0000, 0xa9feffff],
  [0xac100000, 0xac1fffff],
  [0xc0000000, 0xc00000ff],
  [0xc0000200, 0xc00002ff],
  [0xc0586300, 0xc05863ff],
  [0xc0a80000, 0xc0a8ffff],
  [0xc6120000, 0xc613ffff],
  [0xc6336400, 0xc63364ff],
  [0xcb007100, 0xcb0071ff],
  [0xe0000000, 0xffffffff],
]

const IPV6_UNSAFE: ReadonlyArray<readonly [bigint, number]> = [
  [0n, 128],
  [1n, 128],
  [0xfc000000000000000000000000000000n, 7],
  [0xfe800000000000000000000000000000n, 10],
  [0xfec000000000000000000000000000000n, 10],
  [0xff000000000000000000000000000000n, 8],
  [0x20010db8000000000000000000000000n, 32],
  [0x20010002000000000000000000000000n, 48],
  [0x20010000000000000000000000000000n, 23],
  [0x3fff0000000000000000000000000000n, 20],
  [0x0064ff9b000000000000000000000000n, 96],
  [0x0064ff9b000100000000000000000000n, 48],
  [0x01000000000000000000000000000000n, 64],
]

function ipv4Number(value: string): number | null {
  const parts = value.split('.')
  if (parts.length !== 4) return null
  const octets = parts.map(part => /^\d{1,3}$/.test(part) ? Number(part) : -1)
  if (octets.some(part => part < 0 || part > 255)) return null
  return octets[0] * 0x1000000 + octets[1] * 0x10000 + octets[2] * 0x100 + octets[3]
}

function ipv6Number(value: string): bigint | null {
  const sections = value.toLowerCase().split('::')
  if (sections.length > 2) return null
  const parse = (section: string): number[] | null => {
    if (!section) return []
    const words: number[] = []
    for (const part of section.split(':')) {
      if (part.includes('.')) {
        const number = ipv4Number(part)
        if (number == null) return null
        words.push(Math.floor(number / 0x10000), number % 0x10000)
      } else {
        if (!/^[\da-f]{1,4}$/i.test(part)) return null
        words.push(Number.parseInt(part, 16))
      }
    }
    return words
  }
  const left = parse(sections[0])
  const right = parse(sections.length === 2 ? sections[1] : '')
  if (!left || !right) return null
  if (sections.length === 1 && left.length !== 8) return null
  if (sections.length === 2 && left.length + right.length >= 8) return null
  const words = sections.length === 1 ? left : [...left, ...Array(8 - left.length - right.length).fill(0), ...right]
  return words.reduce((result, word) => (result << 16n) | BigInt(word), 0n)
}

function inV6Range(value: bigint, network: bigint, prefix: number): boolean {
  const shift = BigInt(128 - prefix)
  return (value >> shift) === (network >> shift)
}

function unsafeIpv4(value: string): boolean {
  const number = ipv4Number(value)
  return number == null || IPV4_UNSAFE.some(([start, end]) => number >= start && number <= end)
}

function unsafeIpv6(value: string): boolean {
  const number = ipv6Number(value)
  if (number == null) return true
  const mapped = number >> 32n
  const low32 = Number(number & 0xffffffffn)
  if (mapped === 0xffffn) {
    return unsafeIpv4([low32 >>> 24, (low32 >>> 16) & 255, (low32 >>> 8) & 255, low32 & 255].join('.'))
  }
  if (mapped === 0n || (number >> 125n) !== 1n || IPV6_UNSAFE.some(([network, prefix]) => inV6Range(number, network, prefix))) return true
  if ((number >> 112n) === 0x2002n) {
    const embedded = Number((number >> 80n) & 0xffffffffn)
    return unsafeIpv4([embedded >>> 24, (embedded >>> 16) & 255, (embedded >>> 8) & 255, embedded & 255].join('.'))
  }
  if ((number >> 32n) === 0x0064ff9b0000000000000000n) {
    return unsafeIpv4([low32 >>> 24, (low32 >>> 16) & 255, (low32 >>> 8) & 255, low32 & 255].join('.'))
  }
  return false
}

export function assertPublicRemoteHostname(hostname: string): string {
  const normalized = hostname.replace(/^\[|\]$/g, '').replace(/\.$/, '').toLowerCase()
  if (!normalized || /(?:^|\.)(?:localhost|local|localdomain|internal|lan|home|test|invalid|example|onion)$/.test(normalized)) {
    throw new Error('Remote host name is local or reserved')
  }
  return normalized
}

export function assertPublicRemoteAddress(address: string, family?: number): { address: string; family: 4 | 6 } {
  const normalized = address.replace(/^\[|\]$/g, '')
  const detected = isIP(normalized)
  if ((detected !== 4 && detected !== 6) || (family != null && family !== detected)) {
    throw new Error('Remote address is invalid')
  }
  if (detected === 4 ? unsafeIpv4(normalized) : unsafeIpv6(normalized)) {
    throw new Error('Remote address is private or reserved')
  }
  return { address: normalized, family: detected }
}
