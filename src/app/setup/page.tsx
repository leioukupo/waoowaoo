'use client'

import { useEffect, useState, type FormEvent } from 'react'

export default function SetupPage() {
  const [token, setToken] = useState('')
  const [message, setMessage] = useState('')
  const [busy, setBusy] = useState(false)

  useEffect(() => {
    const query = new URLSearchParams(window.location.search)
    setToken(query.get('token') || '')
  }, [])

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    setBusy(true)
    setMessage('正在初始化…')
    const form = new FormData(event.currentTarget)
    const payload = {
      setupToken: token,
      databaseUrl: form.get('databaseUrl'),
      adminName: form.get('adminName'),
      adminEmail: form.get('adminEmail'),
      adminPassword: form.get('adminPassword'),
      redis: { host: form.get('redisHost'), port: Number(form.get('redisPort') || 6379), username: form.get('redisUsername'), password: form.get('redisPassword'), tls: form.get('redisTls') === 'on' },
      temporal: { address: form.get('temporalAddress'), namespace: form.get('temporalNamespace'), taskQueue: form.get('temporalTaskQueue'), apiKey: form.get('temporalApiKey'), tls: form.get('temporalTls') === 'on' },
      storage: { endpoint: form.get('storageEndpoint'), uploadEndpoint: form.get('storageUploadEndpoint') || form.get('storageEndpoint'), region: form.get('storageRegion'), bucket: form.get('storageBucket'), accessKeyId: form.get('storageAccessKey'), secretAccessKey: form.get('storageSecretKey'), forcePathStyle: form.get('storagePathStyle') === 'on' },
      codexRuntime: {
        image: form.get('codexRuntimeImage') || undefined,
        hostRoot: form.get('codexRuntimeHostRoot') || undefined,
        idleTimeoutMs: Number(form.get('codexRuntimeIdleTimeoutMs') || 900000),
        cpuLimit: Number(form.get('codexRuntimeCpu') || 2),
        memoryBytes: Number(form.get('codexRuntimeMemoryBytes') || 2147483648),
        pidsLimit: Number(form.get('codexRuntimePids') || 256),
      },
    }
    const response = await fetch('/api/setup/complete', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(payload) })
    const result = await response.json() as { success?: boolean; error?: { code?: string } }
    setBusy(false)
    setMessage(result.success ? '初始化完成，请重启 Web 容器后登录。' : `初始化失败：${result.error?.code || 'UNKNOWN_ERROR'}`)
  }

  return <main style={{ maxWidth: 760, margin: '0 auto', padding: 32, fontFamily: 'system-ui' }}>
    <h1>Waoowaoo 初始化设置</h1>
    <p>请输入容器日志中的一次性初始化 token，然后配置外部服务。</p>
    <form onSubmit={submit} style={{ display: 'grid', gap: 12 }}>
      <input name="databaseUrl" required placeholder="MySQL DATABASE_URL" />
      <input name="adminName" required placeholder="管理员用户名" />
      <input name="adminEmail" required type="email" placeholder="管理员邮箱" />
      <input name="adminPassword" required minLength={10} type="password" placeholder="管理员密码（至少 10 位）" />
      <input name="redisHost" required placeholder="Redis 主机" defaultValue="127.0.0.1" />
      <input name="redisPort" required type="number" placeholder="Redis 端口" defaultValue="6379" />
      <input name="redisUsername" placeholder="Redis 用户名（可选）" />
      <input name="redisPassword" type="password" placeholder="Redis 密码" />
      <label><input name="redisTls" type="checkbox" /> Redis TLS</label>
      <input name="temporalAddress" required placeholder="Temporal 地址，例如 temporal.example.com:7233" />
      <input name="temporalNamespace" placeholder="Temporal Namespace" defaultValue="waoowaoo" />
      <input name="temporalTaskQueue" placeholder="Temporal Task Queue" defaultValue="waoowaoo-runtime" />
      <input name="temporalApiKey" type="password" placeholder="Temporal API Key（可选）" />
      <label><input name="temporalTls" type="checkbox" /> Temporal TLS</label>
      <input name="storageEndpoint" required placeholder="RustFS/S3 Endpoint" />
      <input name="storageUploadEndpoint" placeholder="Upload Endpoint（可选）" />
      <input name="storageRegion" placeholder="S3 Region" defaultValue="us-east-1" />
      <input name="storageBucket" required placeholder="Bucket" />
      <input name="storageAccessKey" required placeholder="Access Key" />
      <input name="storageSecretKey" required type="password" placeholder="Secret Key" />
      <label><input name="storagePathStyle" type="checkbox" defaultChecked /> S3 Path Style</label>
      <h2>Codex Runtime（可选）</h2>
      <input name="codexRuntimeImage" placeholder="镜像 repository@sha256:digest（留空使用本地预构建）" />
      <input name="codexRuntimeHostRoot" placeholder="Host root（留空使用 Compose 配置）" />
      <input name="codexRuntimeCpu" type="number" min="0.1" step="0.1" defaultValue="2" placeholder="CPU 上限" />
      <input name="codexRuntimeMemoryBytes" type="number" min="268435456" defaultValue="2147483648" placeholder="内存字节数" />
      <input name="codexRuntimePids" type="number" min="32" defaultValue="256" placeholder="PID 上限" />
      <input name="codexRuntimeIdleTimeoutMs" type="number" min="60000" defaultValue="900000" placeholder="空闲清理毫秒数" />
      <button disabled={busy} type="submit">{busy ? '处理中…' : '完成初始化'}</button>
    </form>
    <p>{message}</p>
  </main>
}
