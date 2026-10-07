import { redirect } from 'next/navigation'
import { isRuntimeConfigured } from '@/lib/runtime-config/store'

export const dynamic = 'force-dynamic'

export default function RootPage() {
  redirect(isRuntimeConfigured() ? '/zh' : '/setup')
}
