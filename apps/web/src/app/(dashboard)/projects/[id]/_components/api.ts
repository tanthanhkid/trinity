import apiClient from '@/lib/api-client'
import type { Project } from './types'

export async function fetchProject(id: number): Promise<Project> {
  const res = await apiClient.get<Project>(`/projects/${id}`)
  const data = res.data
  return (data as unknown as { data?: Project }).data ?? data
}
