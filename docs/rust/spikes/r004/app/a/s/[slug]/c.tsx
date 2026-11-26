'use client'
import { useEffect, useState } from 'react'
import { useSegs, Probe } from '@/lib/seg'
export function A(){ const s = useSegs('/a/s')
  const [meta, setMeta] = useState<string|null>(null)
  useEffect(() => setMeta(document.querySelector('meta[name=store-slug]')?.getAttribute('content') || ''), [])
  const slug = s?.[0] === '_' || !s?.[0] ? meta : s[0]  // tên miền phụ: URL là "/" → lấy slug từ <meta>
  return <Probe title="A store" vals={{ slug, meta }} /> }
