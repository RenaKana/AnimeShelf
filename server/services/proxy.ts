import { execSync } from 'child_process'
import { settingsDb } from '../db/instance'

export interface ProxyConfig {
  protocol: 'http' | 'https'
  host: string
  port: number
}

// Clash / Mihomo / v2rayN 在 Windows 上常见的本地 HTTP 代理端口。
// 这里只提供“直连失败后的候选”，不会覆盖设置页或系统代理。
const COMMON_LOCAL_PROXY_PORTS = [7897, 7890, 10809]

export function getLocalProxyFallbacks(): ProxyConfig[] {
  return COMMON_LOCAL_PROXY_PORTS.map(port => ({ protocol: 'http', host: '127.0.0.1', port }))
}

// 读取代理：优先设置项 proxy_url（如 http://127.0.0.1:7897），否则探测 Windows 注册表中的代理地址。
// 注：不检查 ProxyEnable 开关——Clash 类代理常驻端口而系统开关关闭，地址仍有效；代理未运行时请求超时后由调用方兜底。
export function getProxy(): ProxyConfig | null {
  const fromSettings = settingsDb.get('proxy_url')?.trim()
  if (fromSettings) return parseProxy(fromSettings)

  try {
    const server = execSync(
      `reg query "HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Internet Settings" /v ProxyServer`,
      // 未配置系统代理是正常状态，不要把 reg 的错误信息写进开发服务终端。
      { encoding: 'utf8', windowsHide: true, stdio: ['ignore', 'pipe', 'ignore'] },
    )
    const m = server.match(/ProxyServer\s+REG_SZ\s+([^\s\r\n]+)/i)
    return m ? parseProxy(m[1].trim()) : null
  } catch {
    return null
  }
}

function parseProxy(raw: string): ProxyConfig | null {
  const s = raw.trim()
  if (!s) return null
  const m = s.match(/^(?:(https?):\/\/)?([^:\/]+)(?::(\d+))?$/)
  if (!m) return null
  return { protocol: (m[1] ?? 'http') as ProxyConfig['protocol'], host: m[2], port: Number(m[3] ?? 80) }
}
