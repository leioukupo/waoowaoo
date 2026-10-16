/**
 * Clipboard copy that also works in non-secure contexts (plain-HTTP LAN
 * deployments), where the async Clipboard API is unavailable. Falls back to
 * the legacy hidden-textarea + execCommand path.
 */
export async function copyPlainText(text: string): Promise<boolean> {
  if (typeof navigator !== 'undefined' && typeof navigator.clipboard?.writeText === 'function') {
    try {
      await navigator.clipboard.writeText(text)
      return true
    } catch {
      /* fall through to the legacy path */
    }
  }
  if (typeof document === 'undefined') return false
  try {
    const field = document.createElement('textarea')
    field.value = text
    field.setAttribute('readonly', '')
    field.style.position = 'fixed'
    field.style.left = '-9999px'
    field.style.opacity = '0'
    document.body.appendChild(field)
    field.select()
    const succeeded = document.execCommand('copy')
    document.body.removeChild(field)
    return succeeded
  } catch {
    return false
  }
}
