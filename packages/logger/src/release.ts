import { readFileSync } from 'node:fs'
import { join } from 'node:path'

/** Release id: TRINITY_RELEASE → `${APP_ROOT || cwd}/.release`. */
export function resolveRelease(env: NodeJS.ProcessEnv = process.env): string | undefined {
  const explicit = env.TRINITY_RELEASE?.trim()
  if (explicit) return explicit
  try {
    const v = readFileSync(join(env.APP_ROOT || process.cwd(), '.release'), 'utf8').trim()
    return v || undefined
  } catch {
    return undefined
  }
}
