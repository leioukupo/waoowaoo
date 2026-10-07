import type { Metadata } from 'next'
import './globals.css'

export const metadata: Metadata = {
  title: 'Waoowaoo',
  description: 'Waoowaoo creative workspace',
}

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="zh" suppressHydrationWarning>
      <body suppressHydrationWarning>{children}</body>
    </html>
  )
}
