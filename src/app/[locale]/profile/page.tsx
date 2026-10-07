'use client'
import { Suspense, useCallback, useEffect, useRef, useState } from 'react'
import { signOut, useSession } from 'next-auth/react'
import { useSearchParams } from 'next/navigation'
import { useTranslations } from 'next-intl'
import Navbar from '@/components/Navbar'
import ApiConfigTab from './components/ApiConfigTab'
import InfrastructureSettingsTab from './components/InfrastructureSettingsTab'
import ProfileSidebar, { type ProfileSectionItem } from './components/ProfileSidebar'
import type {
  ProfileBalanceSummary,
  ProfileProjectCostDetail,
  ProfileProjectCostSummary,
  ProfileTransactionItem,
} from '@/lib/edition/contracts/client'
import { BrandPageLoading } from '@/components/ui/BrandLoading'
import { AppIcon } from '@/components/ui/icons'
import { useRouter } from '@/i18n/navigation'
import { readProfileSectionParam, type ProfileSection } from '@/lib/profile/sections'
import { apiFetch } from '@/lib/api-fetch'
import { readClientApiError } from '@/lib/errors/client'
import { useToast } from '@/contexts/ToastContext'
import {
  AccountSecurityTab,
  PaidBetaCheckoutSuccessDialog,
  ProfileBillingSection,
  ProfileOverviewSection,
} from '@/lib/edition/current/client'
import {
  isPublicDeploymentFeatures,
  type PublicDeploymentFeatures,
} from '@/lib/deployment/public-client'
import {
  DEFAULT_USER_TIME_ZONE,
  resolveBrowserUserTimeZone,
} from '@/lib/user-time-zone'

type DeploymentPayload = {
  features?: PublicDeploymentFeatures
  billingMode?: string
}

type TransactionsPayload = {
  transactions?: ProfileTransactionItem[]
}

type ProjectCostsPayload = {
  total?: number
  byProject?: ProfileProjectCostSummary[]
}

type ProjectCostDetailsPayload = {
  records?: ProfileProjectCostDetail[]
}

function isDeploymentPayload(value: unknown): value is DeploymentPayload {
  return !!value && typeof value === 'object' && !Array.isArray(value)
}

function isBalancePayload(value: unknown): value is ProfileBalanceSummary {
  return !!value && typeof value === 'object' && !Array.isArray(value)
}

function isTransactionsPayload(value: unknown): value is TransactionsPayload {
  return !!value && typeof value === 'object' && !Array.isArray(value)
}

function isProjectCostsPayload(value: unknown): value is ProjectCostsPayload {
  return !!value && typeof value === 'object' && !Array.isArray(value)
}

function isProjectCostDetailsPayload(value: unknown): value is ProjectCostDetailsPayload {
  return !!value && typeof value === 'object' && !Array.isArray(value)
}

function getDefaultProfileSection(features: PublicDeploymentFeatures): ProfileSection {
  if (features.showBilling) return 'overview'
  if (features.showAccountSecurity) return 'security'
  if (features.showApiConfig) return 'apiConfig'
  return 'infrastructure'
}

function isProfileSectionEnabled(section: ProfileSection, features: PublicDeploymentFeatures): boolean {
  if (section === 'security') return features.showAccountSecurity
  if (section === 'apiConfig') return features.showApiConfig
  if (section === 'infrastructure') return true
  return features.showBilling
}

function ProfilePageContent() {
  const { data: session, status } = useSession()
  const router = useRouter()
  const searchParams = useSearchParams()
  const t = useTranslations('profile')
  const tc = useTranslations('common')
  const { showError } = useToast()
  if (!searchParams) {
    throw new Error('ProfilePage requires searchParams')
  }

  const urlSection = readProfileSectionParam(searchParams.get('section'))

  const [deploymentFeatures, setDeploymentFeatures] = useState<PublicDeploymentFeatures | null>(null)
  const [deploymentLoadFailed, setDeploymentLoadFailed] = useState(false)
  const [balance, setBalance] = useState<ProfileBalanceSummary | null>(null)
  const [transactions, setTransactions] = useState<ProfileTransactionItem[]>([])
  const [projectCosts, setProjectCosts] = useState<ProfileProjectCostSummary[]>([])
  const [totalProjectCost, setTotalProjectCost] = useState(0)
  const [userTimeZone, setUserTimeZone] = useState(DEFAULT_USER_TIME_ZONE)
  const isSigningOutRef = useRef(false)
  const activeSection = deploymentFeatures
    && !isProfileSectionEnabled(urlSection, deploymentFeatures)
    ? getDefaultProfileSection(deploymentFeatures)
    : urlSection
  const checkoutSucceeded = searchParams.get('payment') === 'success'
    || searchParams.get('plan') === 'success'
  const checkoutSessionId = checkoutSucceeded ? searchParams.get('session_id') : null

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect -- Read the browser time zone after hydration to keep server and client markup equal.
    setUserTimeZone(resolveBrowserUserTimeZone())
  }, [])

  const handleSignOut = useCallback(async () => {
    isSigningOutRef.current = true
    try {
      await signOut({ redirect: false, callbackUrl: '/' })
      router.replace({ pathname: '/' })
      router.refresh()
    } catch (error) {
      isSigningOutRef.current = false
      throw error
    }
  }, [router])

  useEffect(() => {
    if (status === 'loading' || isSigningOutRef.current) return
    if (!session) { router.push({ pathname: '/auth/signin' }); return }
  }, [router, session, status])

  useEffect(() => {
    if (!session) return
    let canceled = false

    const loadDeployment = async () => {
      const response = await apiFetch('/api/deployment')
      if (!response.ok) {
        if (!canceled) setDeploymentLoadFailed(true)
        return
      }
      const payload: unknown = await response.json()
      if (!canceled && isDeploymentPayload(payload) && isPublicDeploymentFeatures(payload.features)) {
        setDeploymentFeatures(payload.features)
        setDeploymentLoadFailed(false)
      } else if (!canceled) {
        setDeploymentLoadFailed(true)
      }
    }

    void loadDeployment()
    return () => {
      canceled = true
    }
  }, [session])

  useEffect(() => {
    if (!deploymentFeatures) return
    if (isProfileSectionEnabled(urlSection, deploymentFeatures)) return

    const nextSection = getDefaultProfileSection(deploymentFeatures)
    router.replace(
      { pathname: '/profile', query: { section: nextSection } },
      { scroll: false },
    )
  }, [deploymentFeatures, router, urlSection])

  const loadBalance = useCallback(async () => {
    try {
      const response = await apiFetch('/api/user/balance')
      if (!response.ok) throw await readClientApiError(response)
      const payload: unknown = await response.json()
      if (!isBalancePayload(payload)) throw new Error('BALANCE_RESPONSE_INVALID')
      setBalance(payload)
    } catch (error) {
      showError(error, t('balanceLoadFailed'))
    }
  }, [setBalance, showError, t])

  const loadTransactions = useCallback(async () => {
    try {
      const response = await apiFetch('/api/user/transactions?pageSize=20')
      if (!response.ok) throw await readClientApiError(response)
      const payload: unknown = await response.json()
      if (!isTransactionsPayload(payload) || !Array.isArray(payload.transactions)) {
        throw new Error('TRANSACTIONS_RESPONSE_INVALID')
      }
      setTransactions(payload.transactions)
    } catch (error) {
      showError(error, t('transactionsLoadFailed'))
    }
  }, [setTransactions, showError, t])

  const loadProjectCosts = useCallback(async () => {
    try {
      const response = await apiFetch('/api/user/costs')
      if (!response.ok) throw await readClientApiError(response)
      const payload: unknown = await response.json()
      if (
        !isProjectCostsPayload(payload)
        || typeof payload.total !== 'number'
        || !Array.isArray(payload.byProject)
      ) {
        throw new Error('PROJECT_COSTS_RESPONSE_INVALID')
      }
      setTotalProjectCost(payload.total)
      setProjectCosts(payload.byProject)
    } catch (error) {
      showError(error, t('projectCostsLoadFailed'))
    }
  }, [setProjectCosts, setTotalProjectCost, showError, t])

  const loadProjectCostDetails = useCallback(async (
    projectId: string,
  ): Promise<readonly ProfileProjectCostDetail[]> => {
    try {
      const query = new URLSearchParams({ projectId, pageSize: '100' })
      const response = await apiFetch(`/api/user/costs/details?${query.toString()}`)
      if (!response.ok) throw await readClientApiError(response)
      const payload: unknown = await response.json()
      if (!isProjectCostDetailsPayload(payload) || !Array.isArray(payload.records)) {
        throw new Error('PROJECT_COST_DETAILS_RESPONSE_INVALID')
      }
      return payload.records
    } catch (error) {
      showError(error, t('projectCostDetailsLoadFailed'))
      return []
    }
  }, [showError, t])

  useEffect(() => {
    if (!session || deploymentFeatures?.showBilling !== true) return
    // eslint-disable-next-line react-hooks/set-state-in-effect -- Fetch the authenticated billing snapshot and publish request errors through the shared toast.
    void loadBalance()
    void loadTransactions()
    void loadProjectCosts()
  }, [session, deploymentFeatures, loadBalance, loadTransactions, loadProjectCosts])

  const paymentStatus = searchParams.get('payment')
  const planStatus = searchParams.get('plan')
  const paymentNotice = paymentStatus === 'success'
    ? t('recharge.successNotice')
    : paymentStatus === 'cancel'
      ? t('recharge.cancelNotice')
      : planStatus === 'success'
        ? t('recharge.planSuccessNotice')
        : planStatus === 'cancel'
          ? t('recharge.cancelNotice')
          : null

  if (deploymentLoadFailed) {
    throw new Error('PROFILE_DEPLOYMENT_FEATURES_UNAVAILABLE')
  }

  if (status === 'loading' || !session) {
    return <BrandPageLoading />
  }

  const noBillingText = t('openSourceNoBilling')
  const showBilling = deploymentFeatures?.showBilling === true
  const showRecharge = deploymentFeatures?.showRecharge === true
  const sectionItems: ProfileSectionItem[] = [
    ...(deploymentFeatures?.showBilling === true
      ? [{ section: 'overview' as const, icon: 'user' as const, label: t('accountOverview') }]
      : []),
    ...(deploymentFeatures?.showAccountSecurity === true
      ? [{ section: 'security' as const, icon: 'lock' as const, label: t('accountSecurity.title') }]
      : []),
    ...(deploymentFeatures?.showApiConfig === true
      ? [{ section: 'apiConfig' as const, icon: 'settingsHexAlt' as const, label: t('apiConfig') }]
      : []),
    { section: 'infrastructure' as const, icon: 'settingsHexAlt' as const, label: t('infrastructure') },
    ...(deploymentFeatures?.showBilling === true
      ? [{ section: 'billing' as const, icon: 'receipt' as const, label: t('accountTransactions') }]
      : []),
  ]

  const handleSectionChange = (section: ProfileSection) => {
    router.replace(
      { pathname: '/profile', query: { section } },
      { scroll: false },
    )
  }

  return (
    <div className="glass-page min-h-screen">
      <Navbar />

      <main className="mx-auto max-w-[1240px] px-6 pb-14 pt-2">
        {/* 大标题页头 */}
        <header className="mb-6">
          <h1 className="text-3xl font-bold tracking-tight text-[var(--glass-text-primary)]">
            {t('pageTitle')}
          </h1>
        </header>

        <div className="flex items-start gap-6">
          <ProfileSidebar
            userName={session.user?.name || t('user')}
            userEmail={session.user?.email ?? null}
            sectionItems={sectionItems}
            activeSection={activeSection}
            onSectionChange={handleSectionChange}
            onSignOut={() => { void handleSignOut() }}
          />

          <div className="min-w-0 flex-1">
            {deploymentFeatures === null ? (
              <div className="glass-surface-elevated flex min-h-64 items-center justify-center text-sm text-[var(--glass-text-secondary)]">
                {tc('loading')}
              </div>
            ) : activeSection === 'security' ? (
              <div className="glass-surface-elevated overflow-hidden">
                <AccountSecurityTab
                  enablePasswordAuth={deploymentFeatures.enablePasswordAuth}
                  showGoogleOAuth={deploymentFeatures.showGoogleOAuth}
                  showWechatOfficialAuth={deploymentFeatures.showWechatOfficialAuth}
                />
              </div>
            ) : activeSection === 'apiConfig' && deploymentFeatures.showApiConfig ? (
              <div className="glass-surface-elevated overflow-hidden">
                <ApiConfigTab />
              </div>
            ) : activeSection === 'infrastructure' ? (
              <div className="glass-surface-elevated overflow-hidden">
                <InfrastructureSettingsTab />
              </div>
            ) : activeSection === 'overview' && showBilling ? (
              <ProfileOverviewSection
                balance={balance}
                transactions={transactions}
                timeZone={userTimeZone}
                showUpgrade={showRecharge}
                paymentNotice={paymentNotice}
                onViewAllTransactions={() => handleSectionChange('billing')}
              />
            ) : activeSection === 'billing' && showBilling ? (
              <ProfileBillingSection
                transactions={transactions}
                projectCosts={projectCosts}
                totalProjectCost={totalProjectCost}
                timeZone={userTimeZone}
                currency={balance?.currency}
                onLoadProjectDetails={loadProjectCostDetails}
                onRefresh={() => {
                  void loadBalance()
                  void loadTransactions()
                  void loadProjectCosts()
                }}
              />
            ) : (
              <div className="glass-surface-elevated flex min-h-64 flex-col items-center justify-center px-6 py-16 text-center">
                <AppIcon name="receipt" className="mb-4 h-12 w-12 text-[var(--glass-text-tertiary)]" />
                <p className="text-base font-semibold text-[var(--glass-text-primary)]">{noBillingText}</p>
              </div>
            )}
          </div>
        </div>
      </main>

      <PaidBetaCheckoutSuccessDialog
        providerObjectId={checkoutSessionId}
        onClose={() => {
          router.replace(
            { pathname: '/profile', query: { section: activeSection } },
            { scroll: false },
          )
        }}
      />

    </div>
  )
}

export default function ProfilePage() {
  return (
    <Suspense fallback={<BrandPageLoading />}>
      <ProfilePageContent />
    </Suspense>
  )
}
