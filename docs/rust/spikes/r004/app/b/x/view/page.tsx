'use client'
import { Suspense } from 'react'
import { BQuery } from '@/lib/seg'
export default function P(){ return <Suspense><BQuery title="B view" keys={['objectKey','viewKey']}/></Suspense> }
