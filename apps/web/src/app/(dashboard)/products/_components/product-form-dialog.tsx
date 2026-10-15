"use client"

/**
 * Dialog tạo/sửa sản phẩm — màn "Sản phẩm" (tổng quát hoá
 * đa ngành). Chỉ mở được cho người có quyền `products.manage` (mirror
 * `POST /products` + `PATCH /products/:id`) — caller (`products-screen.tsx`)
 * chịu trách nhiệm gate qua `usePermissions()`, dialog này không tự kiểm quyền.
 *
 * `code` KHOÁ ở chế độ sửa (mirror `UpdateProductDto` — field này KHÔNG có
 * trong DTO sửa: đổi mã là làm chết các tham chiếu tới sản phẩm).
 * `project_id` — OPTIONAL nhưng bất biến sau khi tạo.
 * `category_id`/`attributes` — CÓ THỂ sửa sau khi tạo (BE tự re-validate
 * `attributes` theo def của category MỚI khi đổi).
 */
import { getApiErrorMessage } from "@/lib/api-client"
import { useEffect, useState } from "react"
import { useForm, type Resolver } from "react-hook-form"
import { zodResolver } from "@hookform/resolvers/zod"
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { CurrencyInput } from "@/components/ui/currency-input"
import { Label } from "@/components/ui/label"
import { Textarea } from "@/components/ui/textarea"
import { ShellCheckbox as Checkbox } from "@/components/app-shell/checkbox"
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select"
import { useActiveProjects } from "@/hooks/use-projects"
import { useCreateProduct, useUpdateProduct } from "@/hooks/products/use-products"
import { useAttributeDefs, useProductCategories } from "@/hooks/products/use-product-categories"
import {
  commaToArray,
  productFormSchema,
  toPickerHex,
  type ProductForm,
} from "./product-form-schema"
import {
  DynamicAttributeFields,
  findMissingRequiredAttributes,
  type AttributeValues,
} from "./dynamic-attribute-fields"
import { ProductImageField } from "./product-image-field"
import { ProjectQuickCreateDialog } from "./project-quick-create-dialog"
import type { Product } from "@/types/product"

/** Base-UI `<SelectItem>` không nhận `value=""` — sentinel cho "chưa chọn". */
const NO_PROJECT = "__no_project__"
const NO_CATEGORY = "__no_category__"
/** Item đặc biệt cuối dropdown "Dự án" — mở mini-form tạo nhanh, KHÔNG phải giá trị chọn. */
const CREATE_PROJECT = "__create_project__"

function buildDefaults(p?: Product): ProductForm {
  if (!p) {
    return {
      code: "",
      name: "",
      project_id: "",
      category_id: "",
      description: "",
      price: "",
      brand: "",
      color: "",
      tags: "",
      is_featured: false,
      image_url: "",
      is_active: true,
    }
  }
  return {
    code: p.code,
    name: p.name,
    project_id: p.project_id != null ? String(p.project_id) : "",
    category_id: p.category_id != null ? String(p.category_id) : "",
    description: p.description ?? "",
    price: p.price != null ? String(p.price) : "",
    brand: p.brand ?? "",
    color: p.color ?? "",
    tags: p.tags.join(", "),
    is_featured: p.is_featured,
    image_url: p.image_url ?? "",
    is_active: p.is_active,
  }
}

export function ProductFormDialog({
  open,
  product,
  onClose,
  onSuccess,
}: {
  open: boolean
  product?: Product
  onClose: () => void
  onSuccess: () => void
}) {
  const isEdit = !!product
  const { data: projects = [], isLoading: projectsLoading } = useActiveProjects()
  const { data: categories = [], isLoading: categoriesLoading } = useProductCategories()
  const createMutation = useCreateProduct()
  const updateMutation = useUpdateProduct()
  const mutation = isEdit ? updateMutation : createMutation

  const [attributesState, setAttributesState] = useState<AttributeValues>(product?.attributes ?? {})
  const [quickProjectOpen, setQuickProjectOpen] = useState(false)
  const [invalidKeys, setInvalidKeys] = useState<Set<string>>(new Set())

  const form = useForm<ProductForm>({
    resolver: zodResolver(productFormSchema) as Resolver<ProductForm>,
    defaultValues: buildDefaults(product),
  })

  const categoryIdStr = form.watch("category_id")
  const categoryId = categoryIdStr ? Number(categoryIdStr) : null
  const { data: attributeDefs = [] } = useAttributeDefs(categoryId)

  // Sync prop → state qua useEffect (KHÔNG setState trong thân render).
  useEffect(() => {
    form.reset(buildDefaults(product))
    setAttributesState(product?.attributes ?? {})
    setInvalidKeys(new Set())
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [product?.id, open])

  // đổi DANH MỤC (khác category của sản phẩm đang sửa) → attributes
  // cũ không còn khớp defs mới, reset để tránh gửi lên field lạ (BE sẽ 400
  // "không thuộc danh mục đã chọn" nếu giữ nguyên) — mirror bất biến BE
  // `resolveAttributes`. Bỏ qua lần chạy ĐẦU (mount/prop-sync ở effect trên).
  useEffect(() => {
    const initialCategoryId = product?.category_id != null ? String(product.category_id) : ""
    // Quay lại danh mục gốc → khôi phục attributes đã lưu thay vì để trống.
    setAttributesState(categoryIdStr === initialCategoryId ? (product?.attributes ?? {}) : {})
    setInvalidKeys(new Set())
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [categoryIdStr])

  function handleSubmit(data: ProductForm) {
    const missing = findMissingRequiredAttributes(attributeDefs, attributesState)
    if (missing.length > 0) {
      setInvalidKeys(new Set(missing))
      return
    }
    setInvalidKeys(new Set())

    const shared = {
      name: data.name,
      category_id: data.category_id ? Number(data.category_id) : null,
      attributes: attributesState,
      description: data.description || null,
      price: data.price ? Number(data.price) : null,
      brand: data.brand || null,
      color: data.color || null,
      tags: commaToArray(data.tags),
      is_featured: data.is_featured,
      image_url: data.image_url || null,
    }

    if (isEdit) {
      updateMutation.mutate(
        { id: product!.id, payload: { ...shared, is_active: data.is_active } },
        { onSuccess },
      )
      return
    }
    createMutation.mutate(
      { ...shared, code: data.code, project_id: data.project_id ? Number(data.project_id) : null },
      { onSuccess },
    )
  }

  const selectedProject = projects.find((p) => String(p.id) === form.watch("project_id"))
  const colorValue = form.watch("color")
  const canCheckColor = typeof CSS !== "undefined" && typeof CSS.supports === "function"
  const previewColor =
    colorValue && (!canCheckColor || CSS.supports("color", colorValue))
      ? colorValue
      : "transparent"

  return (
    <Dialog open={open} onOpenChange={onClose}>
      <DialogContent className="flex max-h-[90vh] flex-col overflow-hidden sm:max-w-2xl">
        <DialogHeader className="shrink-0">
          <DialogTitle>{isEdit ? "Sửa sản phẩm" : "Thêm sản phẩm"}</DialogTitle>
        </DialogHeader>
        <form
          onSubmit={form.handleSubmit(handleSubmit)}
          className="flex min-h-0 flex-1 flex-col gap-4 overflow-y-auto px-1 pb-1"
        >
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
            <div className="space-y-1.5">
              <Label htmlFor="p-code">Mã sản phẩm *</Label>
              <Input id="p-code" {...form.register("code")} disabled={isEdit} placeholder="VD: SP-500" />
              <p className="min-h-4 text-xs leading-4 text-destructive">
                {form.formState.errors.code?.message ?? ""}
              </p>
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="p-project">Dự án (nếu có)</Label>
              {isEdit ? (
                <Input value={selectedProject?.name ?? (product!.project_id != null ? `#${product!.project_id}` : "— Không thuộc dự án —")} disabled />
              ) : (
                <Select
                  value={form.watch("project_id") || NO_PROJECT}
                  onValueChange={(v) => {
                    if (v === CREATE_PROJECT) {
                      setQuickProjectOpen(true)
                      return
                    }
                    form.setValue("project_id", v === NO_PROJECT ? "" : (v ?? ""), { shouldValidate: true })
                  }}
                  items={[
                    { value: NO_PROJECT, label: "— Không thuộc dự án —" },
                    ...projects.map((p) => ({ value: String(p.id), label: p.name })),
                    { value: CREATE_PROJECT, label: "+ Tạo dự án mới" },
                  ]}
                >
                  <SelectTrigger id="p-project">
                    <SelectValue placeholder={projectsLoading ? "Đang tải..." : "— Không thuộc dự án —"}>
                      {(v) => {
                        if (projectsLoading) return "Đang tải..."
                        if (!v || v === NO_PROJECT) {
                          return <span className="text-muted-foreground">— Không thuộc dự án —</span>
                        }
                        return projects.find((p) => String(p.id) === v)?.name ?? v
                      }}
                    </SelectValue>
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value={NO_PROJECT}>— Không thuộc dự án —</SelectItem>
                    {projects.map((p) => (
                      <SelectItem key={p.id} value={String(p.id)}>
                        {p.name}
                      </SelectItem>
                    ))}
                    <SelectItem value={CREATE_PROJECT}>+ Tạo dự án mới</SelectItem>
                  </SelectContent>
                </Select>
              )}
              <p className="min-h-4 text-xs leading-4 text-destructive">
                {form.formState.errors.project_id?.message ?? ""}
              </p>
            </div>
          </div>

          <div className="space-y-1.5">
            <Label htmlFor="p-name">Tên sản phẩm *</Label>
            <Input id="p-name" {...form.register("name")} placeholder="VD: Tên sản phẩm hoặc dịch vụ" />
            <p className="min-h-4 text-xs leading-4 text-destructive">
              {form.formState.errors.name?.message ?? ""}
            </p>
          </div>

          <div className="space-y-1.5">
            <Label htmlFor="p-category">Danh mục/ngành</Label>
            <Select
              value={form.watch("category_id") || NO_CATEGORY}
              onValueChange={(v) =>
                form.setValue("category_id", v === NO_CATEGORY ? "" : (v ?? ""), { shouldValidate: true })
              }
              items={[
                { value: NO_CATEGORY, label: "— Chưa phân loại —" },
                ...categories.map((c) => ({ value: String(c.id), label: c.name })),
              ]}
            >
              <SelectTrigger id="p-category">
                <SelectValue placeholder={categoriesLoading ? "Đang tải..." : "— Chưa phân loại —"}>
                  {(v) => {
                    if (categoriesLoading) return "Đang tải..."
                    if (!v || v === NO_CATEGORY) {
                      return <span className="text-muted-foreground">— Chưa phân loại —</span>
                    }
                    return categories.find((c) => String(c.id) === v)?.name ?? v
                  }}
                </SelectValue>
              </SelectTrigger>
              <SelectContent>
                <SelectItem value={NO_CATEGORY}>— Chưa phân loại —</SelectItem>
                {categories.map((c) => (
                  <SelectItem key={c.id} value={String(c.id)}>
                    {c.name}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>

          <DynamicAttributeFields
            defs={attributeDefs}
            values={attributesState}
            onChange={(key, value) => setAttributesState((prev) => ({ ...prev, [key]: value }))}
            invalidKeys={invalidKeys}
          />

          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
            <div className="space-y-1.5">
              <Label htmlFor="p-brand">Thương hiệu</Label>
              <Input id="p-brand" {...form.register("brand")} placeholder="VD: Nhãn hiệu, nhà cung cấp, đối tác" />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="p-color">Màu (hex/tên)</Label>
              <div className="flex items-center gap-2">
                <div className="relative size-8 max-sm:size-11 flex-none rounded-md border focus-within:border-ring focus-within:ring-3 focus-within:ring-ring/50">
                  <span
                    className="absolute inset-0 rounded-[5px]"
                    style={{ backgroundColor: previewColor }}
                    aria-hidden
                  />
                  <input
                    type="color"
                    aria-label="Chọn màu"
                    title="Chọn màu"
                    value={toPickerHex(colorValue)}
                    onChange={(e) =>
                      form.setValue("color", e.target.value, {
                        shouldDirty: true,
                        shouldValidate: true,
                      })
                    }
                    className="absolute inset-0 size-full cursor-pointer opacity-0"
                  />
                </div>
                <Input id="p-color" {...form.register("color")} placeholder="#00753c" />
              </div>
              <p className="min-h-4 text-xs leading-4 text-destructive">
                {form.formState.errors.color?.message ?? ""}
              </p>
            </div>
          </div>

          <div className="space-y-1.5">
            <Label htmlFor="p-tags">Thẻ (phân cách bởi dấu phẩy)</Label>
            <Input id="p-tags" {...form.register("tags")} placeholder="Bán chạy, Mới về, Ưu đãi" />
          </div>

          <div className="space-y-1.5">
            <Label htmlFor="p-description">Mô tả</Label>
            <Textarea id="p-description" rows={3} {...form.register("description")} />
            <p className="min-h-4 text-xs leading-4 text-destructive">
              {form.formState.errors.description?.message ?? ""}
            </p>
          </div>

          <div className="space-y-1.5">
            <Label htmlFor="p-price">Giá (VNĐ)</Label>
            <CurrencyInput
              id="p-price"
              className="w-48"
              placeholder="VD: 500.000"
              value={form.watch("price") ?? ""}
              onValueChange={(digits) =>
                form.setValue("price", digits, { shouldDirty: true, shouldValidate: true })
              }
            />
            <p className="min-h-4 text-xs leading-4 text-destructive">
              {form.formState.errors.price?.message ?? ""}
            </p>
          </div>

          <div className="space-y-1.5">
            <Label htmlFor="p-image">Ảnh minh hoạ</Label>
            <ProductImageField
              value={form.watch("image_url") ?? ""}
              onChange={(url) => form.setValue("image_url", url, { shouldDirty: true })}
            />
          </div>

          <div className="flex flex-wrap items-center gap-4">
            <Label className="flex items-center gap-2 font-normal">
              <Checkbox
                checked={form.watch("is_featured")}
                onCheckedChange={(c) => form.setValue("is_featured", c)}
              />
              Sản phẩm nổi bật
            </Label>
            {isEdit && (
              <Label className="flex items-center gap-2 font-normal">
                <Checkbox
                  checked={form.watch("is_active")}
                  onCheckedChange={(c) => form.setValue("is_active", c)}
                />
                Đang mở bán
              </Label>
            )}
          </div>

          {mutation.isError && (
            <p className="text-sm text-destructive">{getApiErrorMessage(mutation.error, "Lưu thất bại. Vui lòng thử lại.")}</p>
          )}

          <DialogFooter className="shrink-0 pt-2">
            <Button type="button" variant="outline" onClick={onClose}>
              Huỷ
            </Button>
            <Button type="submit" disabled={mutation.isPending}>
              {isEdit ? "Lưu thay đổi" : "Tạo sản phẩm"}
            </Button>
          </DialogFooter>
        </form>
        <ProjectQuickCreateDialog
          open={quickProjectOpen}
          onClose={() => setQuickProjectOpen(false)}
          onCreated={(project) => {
            form.setValue("project_id", String(project.id), { shouldDirty: true, shouldValidate: true })
            setQuickProjectOpen(false)
          }}
        />
      </DialogContent>
    </Dialog>
  )
}
