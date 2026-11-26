'use client'
import { useSegs, Probe } from '@/lib/seg'
export function A(){ const s = useSegs('/a/contacts'); return <Probe title="A contact" vals={{ id: s?.[0] }} /> }
