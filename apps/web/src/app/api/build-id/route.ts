import { NextResponse } from 'next/server'
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'

export const dynamic = 'force-dynamic'
export const runtime = 'nodejs'

let cached: string | null = null

async function readBuildId(): Promise<string> {
  if (cached) return cached
  try {
    const path = join(process.cwd(), '.next', 'BUILD_ID')
    const id = (await readFile(path, 'utf-8')).trim()
    if (id) {
      cached = id
      return id
    }
  } catch {
    // BUILD_ID không đọc được (dev mode, file thiếu) → trả 'unknown'
    // để client skip — không trigger toast nhầm.
  }
  return 'unknown'
}

export async function GET() {
  const buildId = await readBuildId()
  return NextResponse.json(
    { buildId },
    { headers: { 'Cache-Control': 'no-store, must-revalidate' } },
  )
}
