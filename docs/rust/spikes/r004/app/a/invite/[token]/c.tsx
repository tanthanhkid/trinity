'use client'
import { useSegs, Probe } from '@/lib/seg'
export function A(){ const s = useSegs('/a/invite'); return <Probe title="A invite" vals={{ token: s?.[0] ? decodeURIComponent(s[0]) : s?.[0] }} /> }
