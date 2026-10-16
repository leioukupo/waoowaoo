import { prisma } from '@/lib/prisma'
import { getUserApiConfig } from '@/lib/user-api/api-config-service'
import { validateCapabilitySelectionsAgainstModels } from '@/lib/user-api/api-config-capability-defaults'
import { resolveReasoningEffort } from '@/lib/ai-exec/reasoning-effort'
import { ensureAiCatalogsRegistered } from '@/lib/ai-exec/catalog-bootstrap'
import type { StoredModel } from '@/lib/user-api/api-config-types'
import type { ApiError } from '@/lib/api-errors'

const USER_ID = 'b7e045ee-fdba-4a41-9f85-a91515c27aea'
const CHANNEL = 'openai-compat:deepseek'
const MODEL_KEY = `${CHANNEL}::deepseek-flash`
const TMP_USER_ID = 'wao-verify-tmp-user-0001'

let failures = 0
function check(label: string, ok: boolean, detail?: unknown) {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${detail !== undefined ? `  -> ${JSON.stringify(detail)}` : ''}`)
  if (!ok) failures += 1
}

function storedDeepseek(): StoredModel {
  return {
    modelId: 'deepseek-flash',
    modelKey: MODEL_KEY,
    name: 'deepseek-flash',
    type: 'llm',
    provider: CHANNEL,
    price: 0,
  }
}

async function main() {
  ensureAiCatalogsRegistered()

  // 1. GET api-config exposes the fixed field for the openai-compat LLM model
  const apiConfig = await getUserApiConfig(USER_ID)
  const fields = apiConfig.fixedParameterFields[MODEL_KEY]
  const effortField = fields?.find((f) => f.field === 'reasoningEffort')
  check(
    'GET: reasoningEffort fixed field exposed',
    !!effortField
      && effortField.allowUnset === true
      && effortField.defaultValue === 'low'
      && effortField.options.length === 7
      && effortField.options.includes('xhigh'),
    fields,
  )

  // 2. validation: valid stored selection is accepted
  try {
    validateCapabilitySelectionsAgainstModels({ [MODEL_KEY]: { reasoningEffort: 'high' } }, [storedDeepseek()])
    check('validate: valid reasoningEffort accepted', true)
  } catch (error) {
    check('validate: valid reasoningEffort accepted', false, error)
  }

  // 3. validation: unknown field is rejected
  try {
    validateCapabilitySelectionsAgainstModels({ [MODEL_KEY]: { temperature: 0.5 } }, [storedDeepseek()])
    check('validate: unknown field rejected', false)
  } catch (error) {
    const err = error as ApiError
    check('validate: unknown field rejected', err?.code === 'INVALID_PARAMS' && (err as any)?.details?.code === 'CAPABILITY_FIELD_INVALID', (err as any)?.details)
  }

  // 4. validation: invalid value rejected with allowed values
  try {
    validateCapabilitySelectionsAgainstModels({ [MODEL_KEY]: { reasoningEffort: 'insane' } }, [storedDeepseek()])
    check('validate: invalid value rejected', false)
  } catch (error) {
    const err = error as ApiError
    const details = (err as any)?.details ?? {}
    check(
      'validate: invalid value rejected with allowedValues',
      details.code === 'CAPABILITY_VALUE_NOT_ALLOWED' && Array.isArray(details.allowedValues) && details.allowedValues.length === 7,
      details,
    )
  }

  // 5. validation: stale openai-compat model (removed from the list) does not break the page
  try {
    validateCapabilitySelectionsAgainstModels(
      { 'openai-compat:oldchannel::some-model': { reasoningEffort: 'medium' } },
      [storedDeepseek()],
    )
    check('validate: stale openai-compat entry tolerated (GET stays alive)', true)
  } catch (error) {
    check('validate: stale openai-compat entry tolerated (GET stays alive)', false, error)
  }

  // 6. built-in catalog models keep the old strict validation
  const builtinLlm = apiConfig.catalog.models.find(
    (m) => m.type === 'llm' && Array.isArray(m.capabilities?.llm?.reasoningEffortOptions)
      && (m.capabilities?.llm?.reasoningEffortOptions as unknown[]).length > 0,
  )
  if (builtinLlm) {
    const builtinKey = `${builtinLlm.provider}::${builtinLlm.modelId}`
    try {
      validateCapabilitySelectionsAgainstModels({ [builtinKey]: { bogus: 1 } }, [storedDeepseek()])
      check('validate: builtin model unknown field still rejected', false)
    } catch (error) {
      const details = ((error as any)?.details ?? {})
      check('validate: builtin model unknown field still rejected', details.code === 'CAPABILITY_FIELD_INVALID', details)
    }
    const allowed = (builtinLlm.capabilities?.llm?.reasoningEffortOptions as string[])[0]
    try {
      validateCapabilitySelectionsAgainstModels({ [builtinKey]: { reasoningEffort: allowed } }, [storedDeepseek()])
      check('validate: builtin model valid value still accepted', true)
    } catch (error) {
      check('validate: builtin model valid value still accepted', false, error)
    }
  } else {
    console.log('SKIP  no builtin LLM with reasoningEffortOptions in the catalog')
  }

  // 7. runtime: real user without a stored selection falls back to 'low'
  const realEffort = await resolveReasoningEffort({ userId: USER_ID, modelKey: MODEL_KEY, purpose: 'assistant' })
  check('resolveReasoningEffort: no stored selection -> low', realEffort === 'low', realEffort)

  // 8. runtime: stored selection wins (throwaway user)
  const savedJson = JSON.stringify({ [MODEL_KEY]: { reasoningEffort: 'xhigh' } })
  await prisma.user.upsert({
    where: { id: TMP_USER_ID },
    update: { name: 'wao-verify-tmp' },
    create: { id: TMP_USER_ID, name: 'wao-verify-tmp' },
  })
  await prisma.userPreference.upsert({
    where: { userId: TMP_USER_ID },
    update: { capabilityDefaults: savedJson },
    create: { userId: TMP_USER_ID, capabilityDefaults: savedJson },
  })
  try {
    const tmpEffort = await resolveReasoningEffort({ userId: TMP_USER_ID, modelKey: MODEL_KEY, purpose: 'assistant' })
    check('resolveReasoningEffort: stored xhigh honored', tmpEffort === 'xhigh', tmpEffort)

    const highJson = JSON.stringify({ [MODEL_KEY]: { reasoningEffort: 'high' } })
    await prisma.userPreference.update({ where: { userId: TMP_USER_ID }, data: { capabilityDefaults: highJson } })
    const tmpEffort2 = await resolveReasoningEffort({ userId: TMP_USER_ID, modelKey: MODEL_KEY, purpose: 'assistant' })
    check('resolveReasoningEffort: stored high honored after change', tmpEffort2 === 'high', tmpEffort2)

    await prisma.userPreference.update({ where: { userId: TMP_USER_ID }, data: { capabilityDefaults: JSON.stringify({}) } })
    const tmpEffort3 = await resolveReasoningEffort({ userId: TMP_USER_ID, modelKey: MODEL_KEY, purpose: 'assistant' })
    check('resolveReasoningEffort: cleared selection falls back to low', tmpEffort3 === 'low', tmpEffort3)
  } finally {
    await prisma.user.deleteMany({ where: { id: TMP_USER_ID } })
    const leftover = await prisma.user.count({ where: { id: TMP_USER_ID } })
    check('cleanup: throwaway user removed', leftover === 0, leftover)
  }

  console.log(failures === 0 ? 'ALL CHECKS PASSED' : `${failures} CHECK(S) FAILED`)
  process.exit(failures === 0 ? 0 : 1)
}

main().catch((error) => {
  console.error('VERIFY SCRIPT ERROR:', error)
  process.exit(2)
})
