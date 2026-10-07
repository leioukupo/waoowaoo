'use client'

import { useEffect, useRef, useState, type FormEvent, type ReactNode } from 'react'
import {
  SETUP_PROBE_SERVICES,
  type ProbeServiceKey,
  type ProbeServiceResult,
} from '@/lib/setup/probe-spec'

type FormState = {
  token: string
  probeHost: string
  dbHost: string
  dbPort: string
  dbUsername: string
  dbPassword: string
  dbName: string
  adminName: string
  adminEmail: string
  adminPassword: string
  redisHost: string
  redisPort: string
  redisUsername: string
  redisPassword: string
  redisTls: boolean
  temporalHost: string
  temporalPort: string
  temporalNamespace: string
  temporalTaskQueue: string
  temporalApiKey: string
  temporalTls: boolean
  storageScheme: 'http' | 'https'
  storageHost: string
  storagePort: string
  storageUploadEndpoint: string
  storageRegion: string
  storageBucket: string
  storageAccessKey: string
  storageSecretKey: string
  storagePathStyle: boolean
  runtimeImage: string
  runtimeHostRoot: string
  runtimeCpu: string
  runtimeMemoryMb: string
  runtimePids: string
  runtimeIdleSeconds: string
}

const INITIAL_FORM: FormState = {
  token: '',
  probeHost: '',
  dbHost: '',
  dbPort: '3306',
  dbUsername: '',
  dbPassword: '',
  dbName: '',
  adminName: '',
  adminEmail: '',
  adminPassword: '',
  redisHost: '',
  redisPort: '6379',
  redisUsername: '',
  redisPassword: '',
  redisTls: false,
  temporalHost: '',
  temporalPort: '7233',
  temporalNamespace: 'waoowaoo',
  temporalTaskQueue: 'waoowaoo-runtime',
  temporalApiKey: '',
  temporalTls: false,
  storageScheme: 'http',
  storageHost: '',
  storagePort: '9000',
  storageUploadEndpoint: '',
  storageRegion: 'us-east-1',
  storageBucket: '',
  storageAccessKey: '',
  storageSecretKey: '',
  storagePathStyle: true,
  runtimeImage: '',
  runtimeHostRoot: '',
  runtimeCpu: '2',
  runtimeMemoryMb: '2048',
  runtimePids: '256',
  runtimeIdleSeconds: '900',
}

type StringFormKey = {
  [K in keyof FormState]: FormState[K] extends string ? (string extends FormState[K] ? K : never) : never
}[keyof FormState]

const FIELD_LABELS: Record<string, string> = {
  DB_HOST: '数据库主机（IP）',
  DB_PORT: '数据库端口',
  DB_USERNAME: '数据库用户名',
  DB_PASSWORD: '数据库密码',
  DB_NAME: '数据库名',
  ADMIN_NAME: '管理员用户名',
  ADMIN_EMAIL: '管理员邮箱',
  ADMIN_PASSWORD: '管理员密码',
  REDIS_HOST: 'Redis 主机',
  REDIS_PORT: 'Redis 端口',
  TEMPORAL_ADDRESS: 'Temporal 地址',
  S3_ENDPOINT: 'S3 Endpoint',
  S3_UPLOAD_ENDPOINT: '上传 Endpoint',
  S3_BUCKET: 'S3 Bucket',
  S3_ACCESS_KEY_ID: 'S3 Access Key',
  S3_SECRET_ACCESS_KEY: 'S3 Secret Key',
  CODEX_RUNTIME_IDLE_TIMEOUT_MS: 'Codex 空闲清理',
  CODEX_RUNTIME_CPU_LIMIT: 'Codex CPU 上限',
  CODEX_RUNTIME_MEMORY_BYTES: 'Codex 内存',
  CODEX_RUNTIME_PIDS_LIMIT: 'Codex PID 上限',
  CODEX_RUNTIME_HOST_ROOT: 'Codex Host root',
}

function friendlyMessage(code?: string, message?: string): string {
  switch (code) {
    case 'SETUP_TOKEN_INVALID':
      return '初始化 token 缺失或错误：请在 Web 容器日志中找到以 "Waoowaoo setup URL token:" 开头的行（docker logs <容器名> 2>&1 | grep "setup URL token"），把冒号后的一整串 token 复制到页面顶部的"初始化 token"输入框，再重试。'
    case 'SETUP_ALREADY_COMPLETE':
      return '初始化已经完成：请重启 Web 容器后直接登录。'
    case 'DATABASE_URL_PROTOCOL_INVALID':
      return '数据库连接串格式不正确（需以 mysql:// 开头）。若使用拆分字段，请检查主机、端口、用户名、密码、数据库名是否填写完整。'
  }
  if (code?.endsWith('_REQUIRED')) {
    const field = code.slice(0, -'_REQUIRED'.length)
    return `必填项「${FIELD_LABELS[field] ?? field}」没有填写，请补全后重试。`
  }
  if (code === 'DB_PORT_INVALID' || code === 'REDIS_PORT_INVALID') return '端口必须是 1–65535 的整数。'
  if (code === 'DB_NAME_INVALID') return '数据库名不能包含斜杠、空格或反引号。'
  if (code === 'PROBE_RATE_LIMITED') return '探测过于频繁，请稍等 1 分钟后再试。'
  if (
    code === 'S3_ENDPOINT_INVALID' ||
    code === 'S3_ENDPOINT_PROTOCOL_INVALID' ||
    code === 'S3_UPLOAD_ENDPOINT_INVALID' ||
    code === 'S3_UPLOAD_ENDPOINT_PROTOCOL_INVALID'
  ) {
    return 'S3 Endpoint 格式不正确：应为 http://192.168.1.10:9000 或 https://rustfs.example.com 这样的形式（不带路径，不带凭据）。'
  }
  if (code === 'CODEX_RUNTIME_IMAGE_MUST_USE_LOCAL_OR_DIGEST') return 'Codex 镜像必须留空（使用本地预构建）或填写 repository@sha256:digest 格式的不可变摘要。'
  if (message?.includes('Access denied')) return `数据库连接失败：用户名或密码不正确（${message}）`
  if (message?.includes('connect ECONNREFUSED') || message?.includes('ECONNREFUSED')) {
    return `数据库连接失败：目标端口拒绝连接，请检查主机与端口是否开放（${message}）`
  }
  if (message?.includes('getaddrinfo')) return `数据库主机无法解析，请检查 IP/域名（${message}）`
  if (message?.includes('connect ETIMEDOUT') || message?.includes('timeout')) return `数据库连接超时，请检查网络与防火墙（${message}）`
  return `初始化失败：${message || code || 'UNKNOWN_ERROR'}（更多细节见 Web 容器日志）`
}


function probeErrorMessage(error?: { code?: string; retryAfterSeconds?: number }): string {
  switch (error?.code) {
    case 'SETUP_ALREADY_COMPLETE':
      return '初始化已经完成，无需探测。'
    case 'PROBE_HOST_INVALID':
      return '主机格式不正确：请填写不带协议和端口的 IP 或域名，例如 192.168.31.9 或 rustfs.example.com。'
    case 'PROBE_RATE_LIMITED':
      return `探测过于频繁，请约 ${error?.retryAfterSeconds ?? 60} 秒后再试。`
    case 'INVALID_JSON':
      return '探测请求格式不正确，请刷新页面后重试。'
    default:
      return `探测请求失败：${error?.code ?? 'UNKNOWN'}（更多细节见 Web 容器日志）。`
  }
}

function Field({
  label,
  hint,
  required,
  className,
  children,
}: {
  label: string
  hint?: string
  required?: boolean
  className?: string
  children: ReactNode
}) {
  return (
    <label className={`block ${className ?? ''}`}>
      <span className="glass-field-label">
        {label}
        {required ? ' *' : ''}
      </span>
      {children}
      {hint ? <span className="glass-field-hint mt-1 block">{hint}</span> : null}
    </label>
  )
}

function Section({ title, description, children }: { title: string; description?: string; children: ReactNode }) {
  return (
    <section className="glass-surface p-5">
      <h2 className="text-base font-bold">{title}</h2>
      {description ? (
        <p className="glass-field-hint mt-1">{description}</p>
      ) : null}
      <div className="mt-4">{children}</div>
    </section>
  )
}

function probeSummary(services: ProbeServiceResult[]): string {
  return services
    .map((service) => (service.detected ? `${service.label} ✓ ${service.detail ?? service.port}` : `${service.label} ✗`))
    .join('，')
}

export default function SetupPage() {
  const [form, setForm] = useState<FormState>(INITIAL_FORM)
  const [probing, setProbing] = useState(false)
  const [probeMessage, setProbeMessage] = useState('')
  const [probeServices, setProbeResults] = useState<ProbeServiceResult[] | null>(null)
  const [submitting, setSubmitting] = useState(false)
  const [message, setMessage] = useState('')
  const [messageTone, setMessageTone] = useState<'idle' | 'success' | 'error'>('idle')
  const lastProbeHost = useRef('')

  useEffect(() => {
    const query = new URLSearchParams(window.location.search)
    const token = query.get('token')
    if (token) setForm((prev) => ({ ...prev, token }))
  }, [])

  function update<K extends keyof FormState>(key: K, value: FormState[K]) {
    setForm((prev) => ({ ...prev, [key]: value }))
  }

  async function runProbe() {
    const host = form.probeHost.trim()
    setProbeResults(null)
    if (!host) {
      setProbeMessage('请先填写服务主机（IP 或域名）。')
      return
    }
    setProbing(true)
    setProbeMessage('正在探测默认端口：MySQL 3306、Redis 6379、Temporal 7233、RustFS/S3 9000…')
    const response = await fetch('/api/setup/probe', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ host }),
    })
    const result = (await response.json()) as {
      services?: ProbeServiceResult[]
      error?: { code?: string; retryAfterSeconds?: number }
    }
    setProbing(false)
    if (!response.ok) {
      setProbeMessage(probeErrorMessage(result.error))
      return
    }
    const services = result.services ?? []
    setProbeResults(services)
    setProbeMessage(`探测完成：${probeSummary(services)}`)
    setForm((prev) => {
      const next = { ...prev }
      const apply = (key: ProbeServiceKey, hostKey: StringFormKey, portKey: StringFormKey, defaultPort: number) => {
        const service = services.find((item) => item.key === key)
        if (!service?.detected) return
        const previousHost = prev[hostKey]
        if (previousHost === '' || previousHost === lastProbeHost.current) {
          next[hostKey] = host
        }
        const previousPort = prev[portKey]
        if (previousPort === '' || previousPort === String(defaultPort)) {
          next[portKey] = String(service.port)
        }
      }
      apply('mysql', 'dbHost', 'dbPort', 3306)
      apply('redis', 'redisHost', 'redisPort', 6379)
      apply('temporal', 'temporalHost', 'temporalPort', 7233)
      apply('s3', 'storageHost', 'storagePort', 9000)
      return next
    })
    lastProbeHost.current = host
  }

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    setSubmitting(true)
    setMessage('正在初始化…')
    setMessageTone('idle')
    const payload = {
      setupToken: form.token.trim(),
      database: {
        host: form.dbHost.trim(),
        port: Number(form.dbPort || 3306),
        username: form.dbUsername.trim(),
        password: form.dbPassword,
        name: form.dbName.trim(),
      },
      adminName: form.adminName.trim(),
      adminEmail: form.adminEmail.trim(),
      adminPassword: form.adminPassword,
      redis: {
        host: form.redisHost.trim(),
        port: Number(form.redisPort || 6379),
        username: form.redisUsername.trim(),
        password: form.redisPassword,
        tls: form.redisTls,
      },
      temporal: {
        address: `${form.temporalHost.trim()}:${form.temporalPort.trim() || 7233}`,
        namespace: form.temporalNamespace.trim(),
        taskQueue: form.temporalTaskQueue.trim(),
        apiKey: form.temporalApiKey,
        tls: form.temporalTls,
      },
      storage: {
        endpoint: `${form.storageScheme}://${form.storageHost.trim()}${form.storagePort.trim() ? `:${form.storagePort.trim()}` : ''}`,
        ...(form.storageUploadEndpoint.trim() ? { uploadEndpoint: form.storageUploadEndpoint.trim() } : {}),
        region: form.storageRegion.trim(),
        bucket: form.storageBucket.trim(),
        accessKeyId: form.storageAccessKey,
        secretAccessKey: form.storageSecretKey,
        forcePathStyle: form.storagePathStyle,
      },
      codexRuntime: {
        image: form.runtimeImage.trim() || undefined,
        hostRoot: form.runtimeHostRoot.trim() || undefined,
        idleTimeoutMs: Number(form.runtimeIdleSeconds || 900) * 1000,
        cpuLimit: Number(form.runtimeCpu || 2),
        memoryBytes: Number(form.runtimeMemoryMb || 2048) * 1024 * 1024,
        pidsLimit: Number(form.runtimePids || 256),
      },
    }
    const response = await fetch('/api/setup/complete', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(payload),
    })
    const result = (await response.json()) as {
      success?: boolean
      error?: { code?: string; message?: string }
    }
    setSubmitting(false)
    if (result.success) {
      setMessage('初始化完成：请重启 Web 容器（docker compose restart app），然后用刚创建的管理员账号登录。')
      setMessageTone('success')
    } else {
      setMessage(friendlyMessage(result.error?.code, result.error?.message))
      setMessageTone('error')
    }
  }

  const inputClass = 'glass-input-base mt-1 w-full px-3 py-2'

  return (
    <main className="glass-page min-h-screen">
      <div className="mx-auto max-w-3xl space-y-4 px-6 py-12">
        <header>
          <h1 className="text-2xl font-bold">Waoowaoo 初始化设置</h1>
          <p className="glass-field-hint mt-2">
            首次启动：粘贴容器日志中的一次性初始化 token，然后填写外部服务配置。保存后请重启 Web 容器。
          </p>
        </header>

        <form onSubmit={submit} className="space-y-4">
          <Section title="初始化 token" description="容器日志中以 &quot;Waoowaoo setup URL token:&quot; 开头的行，冒号后的一整串字符。">
            <Field label="初始化 token" required>
              <input
                name="token"
                required
                className={inputClass}
                value={form.token}
                onChange={(event) => update('token', event.target.value)}
                placeholder="例如 nS3cqCdAC_EI0qE4KGrD…"
                autoComplete="off"
              />
            </Field>
          </Section>

          <Section title="服务探测（可选）" description="填写一个 IP 或域名，探测 MySQL/Redis/Temporal/RustFS-S3 的默认端口；发现服务后自动填入下方对应字段。">
            <div className="flex flex-wrap items-end gap-3">
              <Field label="服务主机（IP / 域名）" className="min-w-64 flex-1">
                <input
                  name="probeHost"
                  className={inputClass}
                  value={form.probeHost}
                  onChange={(event) => update('probeHost', event.target.value)}
                  onKeyDown={(event) => {
                    if (event.key === 'Enter') {
                      event.preventDefault()
                      void runProbe()
                    }
                  }}
                  placeholder="例如 192.168.31.9"
                  autoComplete="off"
                />
              </Field>
              <button type="button" disabled={probing} className="glass-btn-secondary px-4 py-2 text-sm">
                {probing ? '探测中…' : '探测服务'}
              </button>
            </div>
            {probeMessage ? <p className="glass-field-hint mt-3">{probeMessage}</p> : null}
            {probeServices ? (
              <ul className="mt-2 grid grid-cols-1 gap-1 text-sm md:grid-cols-2">
                {SETUP_PROBE_SERVICES.map((spec) => {
                  const service = probeServices.find((item) => item.key === spec.key)
                  return (
                    <li key={spec.key} className="flex items-center gap-2">
                      <span aria-hidden>{service?.detected ? '✅' : '⬜'}</span>
                      <span>
                        {spec.label}（{spec.defaultPort}）
                        {service?.detail ? `：${service.detail}` : ''}
                      </span>
                    </li>
                  )
                })}
              </ul>
            ) : null}
          </Section>

          <Section title="MySQL 数据库" description="数据库不存在时会自动创建。">
            <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
              <Field label="主机（IP）" required>
                <input name="dbHost" required className={inputClass} value={form.dbHost} onChange={(event) => update('dbHost', event.target.value)} placeholder="192.168.31.9" />
              </Field>
              <Field label="端口" required>
                <input name="dbPort" required type="number" min="1" max="65535" className={inputClass} value={form.dbPort} onChange={(event) => update('dbPort', event.target.value)} />
              </Field>
              <Field label="用户名" required>
                <input name="dbUsername" required className={inputClass} value={form.dbUsername} onChange={(event) => update('dbUsername', event.target.value)} placeholder="waoowaoo" />
              </Field>
              <Field label="密码" required>
                <input name="dbPassword" required type="password" className={inputClass} value={form.dbPassword} onChange={(event) => update('dbPassword', event.target.value)} autoComplete="new-password" />
              </Field>
              <Field label="数据库名" required>
                <input name="dbName" required className={inputClass} value={form.dbName} onChange={(event) => update('dbName', event.target.value)} placeholder="waoowaoo" />
              </Field>
            </div>
          </Section>

          <Section title="管理员账号">
            <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
              <Field label="用户名" required>
                <input name="adminName" required className={inputClass} value={form.adminName} onChange={(event) => update('adminName', event.target.value)} />
              </Field>
              <Field label="邮箱" required>
                <input name="adminEmail" required type="email" className={inputClass} value={form.adminEmail} onChange={(event) => update('adminEmail', event.target.value)} />
              </Field>
              <Field label="密码（至少 10 位）" required className="md:col-span-2">
                <input name="adminPassword" required minLength={10} type="password" className={inputClass} value={form.adminPassword} onChange={(event) => update('adminPassword', event.target.value)} autoComplete="new-password" />
              </Field>
            </div>
          </Section>

          <Section title="Redis">
            <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
              <Field label="主机（IP）" required>
                <input name="redisHost" required className={inputClass} value={form.redisHost} onChange={(event) => update('redisHost', event.target.value)} />
              </Field>
              <Field label="端口" required>
                <input name="redisPort" required type="number" min="1" max="65535" className={inputClass} value={form.redisPort} onChange={(event) => update('redisPort', event.target.value)} />
              </Field>
              <Field label="用户名（可选）">
                <input name="redisUsername" className={inputClass} value={form.redisUsername} onChange={(event) => update('redisUsername', event.target.value)} />
              </Field>
              <Field label="密码（可选）">
                <input name="redisPassword" type="password" className={inputClass} value={form.redisPassword} onChange={(event) => update('redisPassword', event.target.value)} autoComplete="new-password" />
              </Field>
            </div>
            <label className="mt-4 flex items-center gap-2 text-sm">
              <input name="redisTls" type="checkbox" checked={form.redisTls} onChange={(event) => update('redisTls', event.target.checked)} />
              Redis TLS
            </label>
          </Section>

          <Section title="Temporal">
            <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
              <Field label="主机（IP）" required>
                <input name="temporalHost" required className={inputClass} value={form.temporalHost} onChange={(event) => update('temporalHost', event.target.value)} />
              </Field>
              <Field label="端口（默认 7233）" required>
                <input name="temporalPort" required type="number" min="1" max="65535" className={inputClass} value={form.temporalPort} onChange={(event) => update('temporalPort', event.target.value)} />
              </Field>
              <Field label="Namespace">
                <input name="temporalNamespace" className={inputClass} value={form.temporalNamespace} onChange={(event) => update('temporalNamespace', event.target.value)} />
              </Field>
              <Field label="Task Queue">
                <input name="temporalTaskQueue" className={inputClass} value={form.temporalTaskQueue} onChange={(event) => update('temporalTaskQueue', event.target.value)} />
              </Field>
              <Field label="API Key（可选）">
                <input name="temporalApiKey" type="password" className={inputClass} value={form.temporalApiKey} onChange={(event) => update('temporalApiKey', event.target.value)} autoComplete="new-password" />
              </Field>
            </div>
            <label className="mt-4 flex items-center gap-2 text-sm">
              <input name="temporalTls" type="checkbox" checked={form.temporalTls} onChange={(event) => update('temporalTls', event.target.checked)} />
              Temporal TLS
            </label>
          </Section>

          <Section title="RustFS / S3 对象存储">
            <div className="grid grid-cols-1 gap-4 md:grid-cols-3">
              <Field label="协议">
                <select name="storageScheme" className="glass-select-base glass-input-base mt-1 w-full px-3 py-2" value={form.storageScheme} onChange={(event) => update('storageScheme', event.target.value === 'https' ? 'https' : 'http')}>
                  <option value="http">http</option>
                  <option value="https">https</option>
                </select>
              </Field>
              <Field label="主机（IP / 域名）" required>
                <input name="storageHost" required className={inputClass} value={form.storageHost} onChange={(event) => update('storageHost', event.target.value)} placeholder="192.168.31.9 或 rustfs.example.com" />
              </Field>
              <Field label="端口" hint="留空则使用协议默认端口（http 80 / https 443）">
                <input name="storagePort" type="number" min="1" max="65535" className={inputClass} value={form.storagePort} onChange={(event) => update('storagePort', event.target.value)} />
              </Field>
            </div>
            <div className="mt-4 grid grid-cols-1 gap-4 md:grid-cols-2">
              <Field label="Upload Endpoint（可选）" hint="留空与 Endpoint 相同，需完整 URL">
                <input name="storageUploadEndpoint" className={inputClass} value={form.storageUploadEndpoint} onChange={(event) => update('storageUploadEndpoint', event.target.value)} placeholder="https://rustfs.example.com" />
              </Field>
              <Field label="Region">
                <input name="storageRegion" className={inputClass} value={form.storageRegion} onChange={(event) => update('storageRegion', event.target.value)} />
              </Field>
              <Field label="Bucket" required>
                <input name="storageBucket" required className={inputClass} value={form.storageBucket} onChange={(event) => update('storageBucket', event.target.value)} />
              </Field>
              <Field label="Access Key" required>
                <input name="storageAccessKey" required className={inputClass} value={form.storageAccessKey} onChange={(event) => update('storageAccessKey', event.target.value)} />
              </Field>
              <Field label="Secret Key" required>
                <input name="storageSecretKey" required type="password" className={inputClass} value={form.storageSecretKey} onChange={(event) => update('storageSecretKey', event.target.value)} autoComplete="new-password" />
              </Field>
            </div>
            <label className="mt-4 flex items-center gap-2 text-sm">
              <input name="storagePathStyle" type="checkbox" checked={form.storagePathStyle} onChange={(event) => update('storagePathStyle', event.target.checked)} />
              S3 Path Style（自建 MinIO/RustFS 建议开启）
            </label>
          </Section>

          <Section title="Codex Runtime（可选）" description="留空使用 Compose 默认配置与本地预构建镜像。">
            <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
              <Field label="镜像 repository@sha256:digest" className="md:col-span-2">
                <input name="runtimeImage" className={inputClass} value={form.runtimeImage} onChange={(event) => update('runtimeImage', event.target.value)} />
              </Field>
              <Field label="Host root" hint="留空使用 Compose 配置">
                <input name="runtimeHostRoot" className={inputClass} value={form.runtimeHostRoot} onChange={(event) => update('runtimeHostRoot', event.target.value)} placeholder="/var/lib/wao/codex-runtime" />
              </Field>
              <Field label="CPU 上限（核）">
                <input name="runtimeCpu" type="number" min="0.1" step="0.1" className={inputClass} value={form.runtimeCpu} onChange={(event) => update('runtimeCpu', event.target.value)} />
              </Field>
              <Field label="内存（MB）">
                <input name="runtimeMemoryMb" type="number" min="256" className={inputClass} value={form.runtimeMemoryMb} onChange={(event) => update('runtimeMemoryMb', event.target.value)} />
              </Field>
              <Field label="PID 上限">
                <input name="runtimePids" type="number" min="32" className={inputClass} value={form.runtimePids} onChange={(event) => update('runtimePids', event.target.value)} />
              </Field>
              <Field label="空闲清理（秒）">
                <input name="runtimeIdleSeconds" type="number" min="60" className={inputClass} value={form.runtimeIdleSeconds} onChange={(event) => update('runtimeIdleSeconds', event.target.value)} />
              </Field>
            </div>
          </Section>

          <div className="flex items-center gap-4">
            <button disabled={submitting} type="submit" className="glass-btn-primary px-6 py-3">
              {submitting ? '处理中…' : '完成初始化'}
            </button>
          </div>
        </form>

        {message ? (
          <p
            role="status"
            className={`rounded-lg border px-4 py-3 text-sm ${
              messageTone === 'success'
                ? 'border-[var(--glass-tone-success-border,rgba(46,184,92,0.4))] bg-[var(--glass-bg-surface-strong)] text-[var(--glass-tone-success-fg,#2e9e5b)]'
                : messageTone === 'error'
                  ? 'border-[var(--glass-tone-danger-border,rgba(220,80,80,0.4))] bg-[var(--glass-bg-surface-strong)] text-[var(--glass-tone-danger-fg,#d05555)]'
                  : 'border-[var(--glass-stroke-soft)] bg-[var(--glass-bg-surface-strong)] text-[var(--glass-text-secondary)]'
            }`}
          >
            {message}
          </p>
        ) : null}
      </div>
    </main>
  )
}
