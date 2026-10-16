import { readFileSync } from 'node:fs'
import { join } from 'node:path'

/** Release id: TRINITY_RELEASE → VERCEL_GIT_COMMIT_SHA (7 chars) → `${APP_ROOT || cwd}/.release`. */
export function resolveRelease(env: NodeJS.ProcessEnv = process.env): string | undefined {
  const explicit = env.TRINITY_RELEASE?.trim()
  if (explicit) return explicit
  const sha = env.VERCEL_GIT_COMMIT_SHA?.trim()
  if (sha) return sha.slice(0, 7)
  try {
    const v = readFileSync(join(env.APP_ROOT || process.cwd(), '.release'), 'utf8').trim()
    return v || undefined
  } catch {
    return undefined
  }
}
