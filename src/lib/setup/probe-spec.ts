/**
 * 初始化页探测的服务清单（纯数据，可安全导入客户端组件）。
 * 探测实现见 probe.ts（依赖 node:net，仅供服务端使用）。
 */

export type ProbeServiceKey = 'mysql' | 'redis' | 'temporal' | 's3'

export interface ProbeServiceSpec {
  readonly key: ProbeServiceKey
  readonly label: string
  readonly defaultPort: number
}

export const SETUP_PROBE_SERVICES: readonly ProbeServiceSpec[] = [
  { key: 'mysql', label: 'MySQL', defaultPort: 3306 },
  { key: 'redis', label: 'Redis', defaultPort: 6379 },
  { key: 'temporal', label: 'Temporal', defaultPort: 7233 },
  { key: 's3', label: 'RustFS/S3', defaultPort: 9000 },
]

export interface ProbeServiceResult {
  key: ProbeServiceKey
  label: string
  port: number
  detected: boolean
  detail?: string
}

export interface ProbeServicesResponse {
  host: string
  services: ProbeServiceResult[]
}
