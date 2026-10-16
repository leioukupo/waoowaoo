'use client'

import { useCallback, useEffect, useState } from 'react'
import { useTranslations } from 'next-intl'
import { reportClientError } from '@/lib/errors/client-reporter'
import { copyPlainText } from '@/lib/clipboard'

interface LocaleErrorPageProps {
  error: Error & { digest?: string }
  reset: () => void
}

/**
 * 提取可展示的错误编号：优先 error 对象上的 requestId，
 * 其次 URL 上的 requestId 参数，最后回退到 Next 的 error.digest。
 */
function extractIncidentId(error: Error & { digest?: string }): string | null {
  const fromError = (error as Error & { requestId?: unknown }).requestId
  if (typeof fromError === 'string' && fromError.trim()) return fromError.trim()

  if (typeof window !== 'undefined') {
    const fromUrl = new URLSearchParams(window.location.search).get('requestId')
    if (fromUrl && fromUrl.trim()) return fromUrl.trim()
  }

  if (typeof error.digest === 'string' && error.digest) return error.digest
  return null
}

export default function LocaleErrorPage({ error, reset }: LocaleErrorPageProps) {
  const t = useTranslations('errors.errorPage')
  const [copied, setCopied] = useState(false)
  const incidentId = extractIncidentId(error)

  useEffect(() => {
    reportClientError({
      kind: 'react-render',
      message: error.message || error.name || 'React render error',
      stack: error.stack,
      ...(incidentId ? { requestId: incidentId } : {}),
    })
  }, [error, incidentId])

  const handleCopy = useCallback(() => {
    if (!incidentId) return
    void copyPlainText(incidentId).then((ok) => {
      if (!ok) return
      setCopied(true)
      window.setTimeout(() => setCopied(false), 2000)
    })
  }, [incidentId])

  return (
    <main className="flex min-h-screen flex-col items-center justify-center gap-4 px-6 text-center">
      <h1 className="text-2xl font-semibold">{t('title')}</h1>
      <p className="max-w-md text-sm opacity-70">{t('description')}</p>
      {incidentId && (
        <div className="flex items-center gap-2 text-sm">
          <span className="opacity-70">{t('requestIdLabel')}</span>
          <code className="rounded bg-black/10 px-2 py-1 font-mono text-xs dark:bg-white/10">
            {incidentId}
          </code>
          <button
            type="button"
            onClick={handleCopy}
            className="rounded border border-current/30 px-2 py-1 text-xs opacity-80 hover:opacity-100"
          >
            {copied ? t('copied') : t('copy')}
          </button>
        </div>
      )}
      <button
        type="button"
        onClick={reset}
        className="mt-2 rounded-full border border-current/40 px-6 py-2 text-sm font-medium hover:opacity-80"
      >
        {t('retry')}
      </button>
    </main>
  )
}
