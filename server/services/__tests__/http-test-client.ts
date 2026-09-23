import http from 'node:http'
import type { Server } from 'node:http'
import type { AddressInfo } from 'node:net'

export interface TestHttpRequestInit {
  method?: string
  headers?: Record<string, string>
  body?: string
}

export interface TestHttpResponse {
  status: number
  headers: http.IncomingHttpHeaders
  text(): Promise<string>
  binary(): Promise<Buffer>
  json<T = any>(): Promise<T>
}

/**
 * Sends a request to a real local HTTP server without Fetch's forbidden-port
 * URL validation. The server still listens on an ephemeral port, so routes
 * remain covered through Express's actual HTTP stack.
 */
export function requestLocalHttp(
  server: Server,
  requestPath: string,
  init: TestHttpRequestInit = {},
): Promise<TestHttpResponse> {
  const address = server.address()
  if (!address || typeof address === 'string') {
    return Promise.reject(new Error('test HTTP server is not listening'))
  }
  const addressInfo = address as AddressInfo
  const method = init.method ?? 'GET'
  const headers = { ...init.headers }

  return new Promise((resolve, reject) => {
    const request = http.request({
      hostname: '127.0.0.1',
      port: addressInfo.port,
      path: requestPath,
      method,
      headers,
    }, response => {
      const chunks: Buffer[] = []
      response.on('data', chunk => chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)))
      response.on('end', () => {
        const body = Buffer.concat(chunks).toString('utf8')
        resolve({
          status: response.statusCode ?? 0,
          headers: response.headers,
          text: async () => body,
          binary: async () => Buffer.concat(chunks),
          json: async <T>() => JSON.parse(body) as T,
        })
      })
    })
    request.on('error', reject)
    if (init.body !== undefined) request.write(init.body)
    request.end()
  })
}
