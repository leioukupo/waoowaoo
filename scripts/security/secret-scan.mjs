#!/usr/bin/env node
import { execFileSync } from 'node:child_process'
import { existsSync, readFileSync, statSync } from 'node:fs'

const mode = process.argv[2]
const MAX_FILE_BYTES = 1_000_000

const deniedPathRules = [
  {
    id: 'private-env-file',
    test: (filePath) => /^\.env(?:$|\.)/.test(filePath)
      && !/^\.env(?:\.[^.]+)*\.example$/.test(filePath)
      && filePath !== '.env.example',
  },
  {
    id: 'official-cloud-content',
    test: (filePath) => filePath === '.official-content' || filePath.startsWith('.official-content/'),
  },
  {
    id: 'private-certificate',
    test: (filePath) => /\.(?:pem|key|p12|pfx|crt)$/i.test(filePath),
  },
  {
    id: 'private-production-deploy-file',
    test: (filePath) => /^(?:Caddyfile|Dockerfile\.production|docker-compose\.prod\.ya?ml)$/.test(filePath),
  },
  {
    id: 'local-debug-artifact',
    test: (filePath) => /^\.tmp[^/]*$/.test(filePath) || filePath === 'debug-request.json',
  },
  {
    id: 'migration-execution-report',
    test: (filePath) => filePath.startsWith('scripts/migrations/reports/'),
  },
  {
    id: 'private-company-document',
    test: (filePath) => /Hamood Entertainment/i.test(filePath),
  },
]

const secretPatterns = [
  { id: 'stripe-secret-key', pattern: /\bsk_(?:live|test)_[0-9A-Za-z]{24,}\b/g },
  { id: 'stripe-restricted-key', pattern: /\brk_(?:live|test)_[0-9A-Za-z]{24,}\b/g },
  { id: 'stripe-live-public-key', pattern: /\bpk_live_[0-9A-Za-z]{24,}\b/g },
  { id: 'stripe-webhook-secret', pattern: /\bwhsec_[0-9A-Za-z]{24,}\b/g },
  { id: 'openrouter-api-key', pattern: /\bsk-or-v1-[0-9A-Za-z]{32,}\b/g },
  { id: 'openai-api-key', pattern: /\bsk-(?:proj-)?[0-9A-Za-z_-]{32,}\b/g },
  { id: 'anthropic-api-key', pattern: /\bsk-ant-[0-9A-Za-z_-]{32,}\b/g },
  { id: 'google-api-key', pattern: /\bAIza[0-9A-Za-z_-]{30,}\b/g },
  {
    id: 'fal-api-key',
    pattern: /\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}:[0-9a-f]{32,}\b/gi,
  },
  {
    id: 'database-url-with-password',
    pattern: /\b(?:mysql|postgres(?:ql)?|redis):\/\/[^:\s/@]+:[^@\s]+@[^)\s'"`]+/gi,
  },
  {
    id: 'private-key-block',
    pattern: /-----BEGIN [A-Z0-9 ]*PRIVATE KEY-----/g,
  },
  {
    id: 'airwallex-secret-looking-value',
    pattern: /\b(?:AIRWALLEX|airwallex)[A-Z0-9_ .:-]{0,80}(?:secret|client_secret|api_key|token)[A-Z0-9_ .:-]{0,20}[:=]\s*["']?[A-Za-z0-9_-]{24,}/gi,
  },
  {
    id: 'private-company-name',
    pattern: /\bHamood Entertainment Co\.?, Limited\b/gi,
  },
]

const sensitiveAssignmentPattern =
  /^[ \t]*(?:export[ \t]+)?([A-Z0-9_]*(?:SECRET|API_KEY|ACCESS_KEY|PRIVATE_KEY|TOKEN|PASSWORD|WEBHOOK_SECRET|CLIENT_SECRET)[A-Z0-9_]*)[ \t]*=[ \t]*["']?([^"'\s#][^"'#\r\n]*)/gm

const allowedAssignmentValues = [
  '',
  '0',
  '1',
  'false',
  'true',
  'test',
  'dummy',
  'fake',
  'example',
  'placeholder',
  'change-me',
  'changeme',
  'replace-me',
  'replace_with_value',
  'your-key',
  'your-secret',
  'your-token',
  'your-password',
]

function runGit(args) {
  return execFileSync('git', args, {
    encoding: 'buffer',
    stdio: ['ignore', 'pipe', 'pipe'],
  })
}

function splitNullList(buffer) {
  return buffer
    .toString('utf8')
    .split('\0')
    .map((item) => item.trim())
    .filter(Boolean)
}

function getRepoFiles() {
  return splitNullList(runGit(['ls-files', '-z'])).filter((filePath) => existsSync(filePath))
}

function getStagedFiles() {
  return splitNullList(runGit(['diff', '--cached', '--name-only', '--diff-filter=ACMR', '-z']))
}

function getStagedContent(filePath) {
  try {
    return runGit(['show', `:${filePath}`])
  } catch {
    return null
  }
}

function getRepoContent(filePath) {
  if (!existsSync(filePath)) return null
  const stats = statSync(filePath)
  if (!stats.isFile()) return null
  if (stats.size > MAX_FILE_BYTES) return null
  return readFileSync(filePath)
}

function isLikelyText(buffer) {
  const limit = Math.min(buffer.length, 8_000)
  for (let index = 0; index < limit; index += 1) {
    if (buffer[index] === 0) return false
  }
  return true
}

function lineNumberForIndex(content, index) {
  let line = 1
  for (let cursor = 0; cursor < index; cursor += 1) {
    if (content.charCodeAt(cursor) === 10) line += 1
  }
  return line
}

function isPlaceholderValue(rawValue) {
  const value = rawValue.trim().replace(/^['"]|['"]$/g, '')
  const lower = value.toLowerCase()
  if (allowedAssignmentValues.includes(lower)) return true
  if (/^\$\{[A-Z0-9_]+\}$/i.test(value)) return true
  if (/^<[^>]+>$/.test(value)) return true
  if (/^(?:x+|\*+|_+|-+)$/i.test(value)) return true
  if (/^(?:your|replace|example|dummy|fake|test)[-_a-z0-9]*$/i.test(value)) return true
  return false
}

function findContentFindings(filePath, content) {
  const findings = []

  for (const rule of secretPatterns) {
    rule.pattern.lastIndex = 0
    let match = rule.pattern.exec(content)
    while (match) {
      const matchedText = match[0] || ''
      if (!isAllowedContentMatch(filePath, rule.id, matchedText)) {
        findings.push({
          id: rule.id,
          filePath,
          line: lineNumberForIndex(content, match.index),
        })
      }
      match = rule.pattern.exec(content)
    }
  }

  if (!isExampleEnvFile(filePath)) {
    sensitiveAssignmentPattern.lastIndex = 0
    let assignmentMatch = sensitiveAssignmentPattern.exec(content)
    while (assignmentMatch) {
      const key = assignmentMatch[1] || ''
      const value = assignmentMatch[2] || ''
      if (!isPlaceholderValue(value)) {
        findings.push({
          id: `sensitive-assignment:${key}`,
          filePath,
          line: lineNumberForIndex(content, assignmentMatch.index),
        })
      }
      assignmentMatch = sensitiveAssignmentPattern.exec(content)
    }
  }

  return findings
}

function isExampleEnvFile(filePath) {
  return filePath === '.env.example' || /^\.env(?:\.[^.]+)*\.example$/.test(filePath)
}

function isAllowedContentMatch(filePath, ruleId, matchedText) {
  if (ruleId !== 'database-url-with-password') return false
  if (
    filePath === '.env.example'
    || filePath === 'docker-compose.yml'
    || filePath === 'docker-compose.test.yml'
    || filePath === 'tests/setup/env.ts'
  ) {
    return /:\/\/root:(?:root|waoowaoo123)@(?:localhost|127\.0\.0\.1|mysql)(?::\d+)?\//.test(matchedText)
  }
  // 基础设施设置表单的占位示例（用户可见的提示文案，不含真实凭据）。
  // 常量拆段拼接，避免本脚本命中自己的扫描规则。
  const examplePlaceholder = ['mysql://user', 'password@host:3306/database'].join(':')
  if (
    filePath === 'src/app/[locale]/profile/components/InfrastructureSettingsTab.tsx'
    && matchedText === examplePlaceholder
  ) {
    return true
  }
  // 初始化流程在运行期由表单输入拼装连接串（模板字面量，不是静态凭据）。
  if (
    filePath === 'src/app/api/setup/complete/route.ts'
    && matchedText.includes('${encodeURIComponent(username)}')
  ) {
    return true
  }
  return false
}

function findPathFindings(filePath) {
  return deniedPathRules
    .filter((rule) => rule.test(filePath))
    .map((rule) => ({
      id: rule.id,
      filePath,
      line: 1,
    }))
}

function scanFiles(files, readContent) {
  const findings = []
  for (const filePath of files) {
    findings.push(...findPathFindings(filePath))

    const buffer = readContent(filePath)
    if (!buffer || buffer.length > MAX_FILE_BYTES || !isLikelyText(buffer)) continue

    findings.push(...findContentFindings(filePath, buffer.toString('utf8')))
  }
  return findings
}

function printFindings(findings) {
  console.error('\n[secret-scan] Sensitive content blocked:')
  for (const finding of findings) {
    console.error(`- ${finding.filePath}:${finding.line} ${finding.id}`)
  }
  console.error('\nMove private values into ignored environment files or rotate the exposed credential before retrying.\n')
}

function main() {
  if (mode !== '--staged' && mode !== '--repo') {
    console.error('Usage: node scripts/security/secret-scan.mjs --staged|--repo')
    process.exit(2)
  }

  const files = mode === '--staged' ? getStagedFiles() : getRepoFiles()
  if (files.length === 0) {
    console.log('[secret-scan] OK no files to scan')
    return
  }

  const findings = scanFiles(files, mode === '--staged' ? getStagedContent : getRepoContent)
  if (findings.length > 0) {
    printFindings(findings)
    process.exit(1)
  }

  console.log(`[secret-scan] OK scanned ${files.length} ${mode === '--staged' ? 'staged' : 'tracked'} files`)
}

main()
