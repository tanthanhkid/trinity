'use client'

import { useEffect } from 'react'
import { useQueryClient, useMutation } from '@tanstack/react-query'
import { useForm, type Resolver } from 'react-hook-form'
import { zodResolver } from '@hookform/resolvers/zod'
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import apiClient from '@/lib/api-client'
import {
  type Project,
  type ProjectForm,
  projectFormSchema,
} from './project-types'
import { ProjectFormFields } from './project-form-fields'

export type { Project, ProjectForm }
export { COLOR_MAP, COLOR_LABEL, COLOR_OPTIONS } from './project-types'

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function buildDefaults(p?: Project): ProjectForm {
  if (!p) {
    return {
      name: '',
      code: '',
      color: undefined,
    }
  }
  return {
    name: p.name,
    code: p.code,
    color: p.color ?? undefined,
  }
}

// ---------------------------------------------------------------------------
// ProjectFormDialog — shared create/edit dialog
// ---------------------------------------------------------------------------

interface ProjectFormDialogProps {
  open: boolean
  project?: Project
  onClose: () => void
  onSuccess: () => void
}

export function ProjectFormDialog({
  open,
  project,
  onClose,
  onSuccess,
}: ProjectFormDialogProps) {
  const queryClient = useQueryClient()
  const isEdit = !!project

  const form = useForm<ProjectForm>({
    resolver: zodResolver(projectFormSchema) as Resolver<ProjectForm>,
    defaultValues: buildDefaults(project),
  })

  // ✅ ĐÚNG: sync prop → state qua useEffect (KHÔNG setState trong thân render)
  useEffect(() => {
    form.reset(buildDefaults(project))
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [project?.id])

  const mutation = useMutation({
    mutationFn: (data: ProjectForm) => {
      const body: Record<string, unknown> = {
        name: data.name,
        color: data.color,
      }
      if (!isEdit) body.code = data.code
      return isEdit
        ? apiClient.patch(`/projects/${project!.id}`, body)
        : apiClient.post('/projects', body)
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['projects'] })
      form.reset(buildDefaults())
      onSuccess()
    },
  })

  return (
    <Dialog open={open} onOpenChange={onClose}>
      <DialogContent className="sm:max-w-lg flex flex-col max-h-[90vh] overflow-hidden">
        <DialogHeader className="shrink-0">
          <DialogTitle>
            {isEdit ? 'Chỉnh sửa dự án' : 'Tạo dự án mới'}
          </DialogTitle>
        </DialogHeader>
        <form
          onSubmit={form.handleSubmit((d) => mutation.mutate(d))}
          className="flex flex-col flex-1 min-h-0"
        >
          <ProjectFormFields
            form={form}
            isEdit={isEdit}
            isPending={mutation.isPending}
            isError={mutation.isError}
            onClose={onClose}
          />
        </form>
      </DialogContent>
    </Dialog>
  )
}
