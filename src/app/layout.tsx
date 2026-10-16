import type { Metadata } from 'next'
import './globals.css'

export const metadata: Metadata = {
  title: 'Waoowaoo',
  description: 'Waoowaoo creative workspace',
}

// crypto.randomUUID is only exposed in secure contexts (HTTPS/localhost). The
// workspace runs on plain HTTP on many LAN deployments, where the browser
// omits the method entirely. This script runs before any app bundle, so every
// client-side caller can rely on a real (getRandomValues-backed) v4 UUID.
const cryptoUuidPolyfill = `(function () {
  try {
    var cryptoObj = window.crypto
    if (!cryptoObj || typeof cryptoObj.randomUUID === 'function') return
    var randomBytes = function (size) {
      var out = new Uint8Array(size)
      if (typeof cryptoObj.getRandomValues === 'function') {
        cryptoObj.getRandomValues(out)
        return out
      }
      for (var k = 0; k < size; k += 1) out[k] = Math.floor(Math.random() * 256)
      return out
    }
    cryptoObj.randomUUID = function () {
      var bytes = randomBytes(16)
      bytes[6] = (bytes[6] & 0x0f) | 0x40
      bytes[8] = (bytes[8] & 0x3f) | 0x80
      var hex = ''
      for (var i = 0; i < 16; i += 1) hex += bytes[i].toString(16).padStart(2, '0')
      return hex.slice(0, 8) + '-' + hex.slice(8, 12) + '-' + hex.slice(12, 16) + '-' + hex.slice(16, 20) + '-' + hex.slice(20)
    }
  } catch (error) {
    /* A polyfill failure must never take a page down. */
  }
})()`

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="zh" suppressHydrationWarning>
      <head>
        <script dangerouslySetInnerHTML={{ __html: cryptoUuidPolyfill }} />
      </head>
      <body suppressHydrationWarning>{children}</body>
    </html>
  )
}
