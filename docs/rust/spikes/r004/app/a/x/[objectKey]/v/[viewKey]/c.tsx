'use client'
import { useSegs, Probe } from '@/lib/seg'
export function A(){ const s = useSegs('/a/x'); return <Probe title="A view" vals={{ objectKey: s?.[0], viewKey: s?.[2] }} /> }
