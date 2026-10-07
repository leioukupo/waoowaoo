'use client'

import { useEffect, useState } from 'react'

type PublicSettings = Record<string, unknown>

export default function InfrastructureSettingsTab() {
  const [settings, setSettings] = useState<PublicSettings | null>(null)
  const [message, setMessage] = useState('')

  useEffect(() => {
    void fetch('/api/admin/infrastructure-settings').then(async (response) => {
      if (response.ok) setSettings(await response.json() as PublicSettings)
      else setMessage('无权访问基础设施设置')
    })
  }, [])

  async function save() {
    const response = await fetch('/api/admin/infrastructure-settings', {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(settings || {}),
    })
    if (!response.ok) {
      setMessage('保存失败')
      return
    }
    const result = await response.json() as { restartRequired?: boolean }
    setMessage(result.restartRequired
      ? '已保存。Redis、Temporal、RustFS 将热重载；MySQL 或 Runtime 设置修改需要重启。'
      : '已保存。Redis、Temporal、RustFS 将在后续请求中重新连接。')
  }

  if (!settings) return <div className="p-6 text-sm text-[var(--glass-text-secondary)]">{message || '加载中…'}</div>
  const redis = (settings.redis || {}) as Record<string, unknown>
  const temporal = (settings.temporal || {}) as Record<string, unknown>
  const storage = (settings.storage || {}) as Record<string, unknown>
  const codexRuntime = (settings.codexRuntime || {}) as Record<string, unknown>
  const codexRuntimeImage = (settings.codexRuntimeImage || {}) as Record<string, unknown>
  return <div className="space-y-4 p-6">
    <h2 className="text-xl font-bold">基础设施设置</h2>
    <p className="text-sm text-[var(--glass-text-secondary)]">配置外部 MySQL、Redis、Temporal 和 RustFS/S3 服务。</p>
    <label className="block text-sm">MySQL 连接串<input className="glass-input-base mt-1 w-full px-3 py-2" value={String(settings.databaseUrl || '')} placeholder={String((settings.mysql as Record<string, unknown> | undefined)?.hint || 'mysql://user:password@host:3306/database')} onChange={(event) => setSettings({ ...settings, databaseUrl: event.target.value })} /></label>
    <div className="grid grid-cols-1 gap-3 md:grid-cols-2">
      <label className="text-sm">Redis 主机<input className="glass-input-base mt-1 w-full px-3 py-2" value={String(redis.host || '')} onChange={(event) => setSettings({ ...settings, redis: { ...redis, host: event.target.value } })} /></label>
      <label className="text-sm">Redis 端口<input type="number" className="glass-input-base mt-1 w-full px-3 py-2" value={String(redis.port || '')} onChange={(event) => setSettings({ ...settings, redis: { ...redis, port: Number(event.target.value) } })} /></label>
      <label className="text-sm">Redis 用户名<input className="glass-input-base mt-1 w-full px-3 py-2" value={String(redis.username || '')} onChange={(event) => setSettings({ ...settings, redis: { ...redis, username: event.target.value } })} /></label>
      <label className="text-sm">Redis 密码（留空保持不变）<input type="password" className="glass-input-base mt-1 w-full px-3 py-2" onChange={(event) => setSettings({ ...settings, redis: { ...redis, password: event.target.value } })} /></label>
      <label className="flex items-center gap-2 text-sm"><input type="checkbox" checked={redis.tls === true} onChange={(event) => setSettings({ ...settings, redis: { ...redis, tls: event.target.checked } })} /> Redis TLS</label>
    </div>
    <div className="grid grid-cols-1 gap-3 md:grid-cols-2">
      <label className="text-sm">Temporal 地址<input className="glass-input-base mt-1 w-full px-3 py-2" value={String(temporal.address || '')} onChange={(event) => setSettings({ ...settings, temporal: { ...temporal, address: event.target.value } })} /></label>
      <label className="text-sm">Temporal Namespace<input className="glass-input-base mt-1 w-full px-3 py-2" value={String(temporal.namespace || '')} onChange={(event) => setSettings({ ...settings, temporal: { ...temporal, namespace: event.target.value } })} /></label>
      <label className="text-sm">Temporal Task Queue<input className="glass-input-base mt-1 w-full px-3 py-2" value={String(temporal.taskQueue || '')} onChange={(event) => setSettings({ ...settings, temporal: { ...temporal, taskQueue: event.target.value } })} /></label>
      <label className="text-sm">Temporal API Key（留空保持不变）<input type="password" className="glass-input-base mt-1 w-full px-3 py-2" onChange={(event) => setSettings({ ...settings, temporal: { ...temporal, apiKey: event.target.value } })} /></label>
      <label className="flex items-center gap-2 text-sm"><input type="checkbox" checked={temporal.tls === true} onChange={(event) => setSettings({ ...settings, temporal: { ...temporal, tls: event.target.checked } })} /> Temporal TLS</label>
    </div>
    <div className="grid grid-cols-1 gap-3 md:grid-cols-2">
      <label className="text-sm">RustFS/S3 Endpoint<input className="glass-input-base mt-1 w-full px-3 py-2" value={String(storage.endpoint || '')} onChange={(event) => setSettings({ ...settings, storage: { ...storage, endpoint: event.target.value } })} /></label>
      <label className="text-sm">RustFS/S3 Upload Endpoint<input className="glass-input-base mt-1 w-full px-3 py-2" value={String(storage.uploadEndpoint || '')} onChange={(event) => setSettings({ ...settings, storage: { ...storage, uploadEndpoint: event.target.value } })} /></label>
      <label className="text-sm">Bucket<input className="glass-input-base mt-1 w-full px-3 py-2" value={String(storage.bucket || '')} onChange={(event) => setSettings({ ...settings, storage: { ...storage, bucket: event.target.value } })} /></label>
      <label className="text-sm">Access Key<input className="glass-input-base mt-1 w-full px-3 py-2" value={String(storage.accessKeyId || '')} onChange={(event) => setSettings({ ...settings, storage: { ...storage, accessKeyId: event.target.value } })} /></label>
      <label className="text-sm">Secret Key（留空保持不变）<input type="password" className="glass-input-base mt-1 w-full px-3 py-2" onChange={(event) => setSettings({ ...settings, storage: { ...storage, secretAccessKey: event.target.value } })} /></label>
      <label className="flex items-center gap-2 text-sm"><input type="checkbox" checked={storage.forcePathStyle === true} onChange={(event) => setSettings({ ...settings, storage: { ...storage, forcePathStyle: event.target.checked } })} /> S3 Path Style</label>
    </div>
      <div className="glass-surface-soft space-y-1 rounded-xl p-3 text-xs text-[var(--glass-text-secondary)]">
      <div className="font-semibold text-[var(--glass-text-primary)]">Codex Runtime</div>
      <div>镜像：{String(codexRuntime.image || '本地预构建镜像')}</div>
      <div>镜像 ID：{String(codexRuntimeImage.imageId || '不可用')}</div>
      <div>源码指纹：{String(codexRuntimeImage.sourceSha256 || '—')}</div>
      <div>最后构建：{String(codexRuntimeImage.builtAt || '—')}</div>
      <div>Docker Socket：{settings.codexRuntimeDockerSocket === true ? '可用' : '不可用'}</div>
      {codexRuntimeImage.error ? <div className="text-red-500">构建错误：{String(codexRuntimeImage.error)}</div> : null}
    </div>
    <label className="block text-sm">Codex Runtime 镜像（本地 :local 或 repository@sha256 digest）
      <input className="glass-input-base mt-1 w-full px-3 py-2 font-mono text-xs" value={String(codexRuntime.image || '')} placeholder="留空使用本地预构建镜像" onChange={(event) => setSettings({ ...settings, codexRuntime: { ...codexRuntime, image: event.target.value } })} />
    </label>
    <div className="grid grid-cols-1 gap-3 md:grid-cols-3">
      <label className="text-sm">CPU<input type="number" min="0.1" step="0.1" className="glass-input-base mt-1 w-full px-3 py-2" value={String(codexRuntime.cpuLimit || '')} onChange={(event) => setSettings({ ...settings, codexRuntime: { ...codexRuntime, cpuLimit: Number(event.target.value) } })} /></label>
      <label className="text-sm">内存 bytes<input type="number" min="268435456" className="glass-input-base mt-1 w-full px-3 py-2" value={String(codexRuntime.memoryBytes || '')} onChange={(event) => setSettings({ ...settings, codexRuntime: { ...codexRuntime, memoryBytes: Number(event.target.value) } })} /></label>
      <label className="text-sm">PID 上限<input type="number" min="32" className="glass-input-base mt-1 w-full px-3 py-2" value={String(codexRuntime.pidsLimit || '')} onChange={(event) => setSettings({ ...settings, codexRuntime: { ...codexRuntime, pidsLimit: Number(event.target.value) } })} /></label>
      <label className="text-sm">Host root<input className="glass-input-base mt-1 w-full px-3 py-2" value={String(codexRuntime.hostRoot || '')} onChange={(event) => setSettings({ ...settings, codexRuntime: { ...codexRuntime, hostRoot: event.target.value } })} /></label>
      <label className="text-sm">空闲超时 ms<input type="number" min="60000" className="glass-input-base mt-1 w-full px-3 py-2" value={String(codexRuntime.idleTimeoutMs || '')} onChange={(event) => setSettings({ ...settings, codexRuntime: { ...codexRuntime, idleTimeoutMs: Number(event.target.value) } })} /></label>
      <label className="text-sm">Runtime 网络<input className="glass-input-base mt-1 w-full px-3 py-2" value={String(codexRuntime.networkName || '')} onChange={(event) => setSettings({ ...settings, codexRuntime: { ...codexRuntime, networkName: event.target.value } })} /></label>
    </div>
    <button type="button" onClick={() => void save()} className="glass-btn-base glass-btn-primary px-4 py-2">保存设置</button>
    <p className="text-sm text-[var(--glass-text-secondary)]">{message}</p>
  </div>
}
