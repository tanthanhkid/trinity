'use client'

import { useMutation, useQueryClient } from '@tanstack/react-query'
import apiClient from '../lib/api-client'

interface UpdateProfileData {
  full_name?: string
  phone?: string
}

interface ChangePasswordData {
  currentPassword: string
  newPassword: string
}

export function useUpdateProfile() {
  const queryClient = useQueryClient()

  return useMutation({
    mutationFn: async (data: UpdateProfileData) => {
      const res = await apiClient.patch('/auth/profile', data)
      return res.data as { message: string }
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['auth', 'me'] })
    },
  })
}

export function useUploadAvatar() {
  const queryClient = useQueryClient()

  return useMutation({
    mutationFn: async (file: File) => {
      const formData = new FormData()
      formData.append('file', file)
      const res = await apiClient.post('/auth/profile/avatar', formData, {
        headers: { 'Content-Type': 'multipart/form-data' },
      })
      return res.data as { avatar_url: string; message: string }
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['auth', 'me'] })
    },
  })
}

export function useChangePassword() {
  return useMutation({
    mutationFn: async (data: ChangePasswordData) => {
      const res = await apiClient.patch('/auth/password', data)
      return res.data as { message: string }
    },
  })
}

export function useResetMyPassword() {
  return useMutation({
    mutationFn: async (currentPassword: string) => {
      const res = await apiClient.post('/auth/reset-password', { currentPassword })
      return res.data as { newPassword: string; message: string }
    },
  })
}
