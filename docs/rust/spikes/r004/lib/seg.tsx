'use client'
import { usePathname, useSearchParams } from 'next/navigation'
import { useEffect, useState } from 'react'
import Link from 'next/link'
// A: tham số từ pathname thực, chỉ đọc sau mount để tránh lệch hydrate với trang giữ chỗ.
export function useSegs(prefix: string): string[] | null {
  const p = usePathname()
  const [ok, setOk] = useState(false)
  useEffect(() => setOk(true), [])
  if (!ok) return null
  const parts = p.split('/').filter(Boolean)
  return parts.slice(prefix.split('/').filter(Boolean).length)
}
export function Probe({ title, vals }: { title: string; vals: Record<string, string | null | undefined> }) {
  return <main><h2 id="title">{title}</h2><pre id="vals">{JSON.stringify(vals)}</pre><Link id="home" href="/">home</Link></main>
}
export function BQuery({ title, keys }: { title: string; keys: string[] }) {
  const sp = useSearchParams()
  const vals: Record<string, string | null> = {}
  for (const k of keys) vals[k] = sp.get(k)
  return <Probe title={title} vals={vals} />
}
export function BHash({ title }: { title: string }) {
  const [t, setT] = useState<string | null>(null)
  useEffect(() => setT(decodeURIComponent(window.location.hash.slice(1))), [])
  return <Probe title={title} vals={{ token: t }} />
}
