import { describe, expect, it } from 'vitest'
import { buildBlobUploadUrl, isBlobUploadsEnabled } from '@/lib/uploads-blob'

const env = (o: Record<string, string>) => o as unknown as NodeJS.ProcessEnv
const TOKEN = ['vercel', 'blob', 'rw', 's1', 'x'].join('_')

describe('uploads-blob', () => {
  it('chỉ bật khi STORAGE_DRIVER=vercel-blob và có token', () => {
    expect(isBlobUploadsEnabled(env({}))).toBe(false)
    expect(isBlobUploadsEnabled(env({ STORAGE_DRIVER: 'vercel-blob' }))).toBe(false)
    expect(isBlobUploadsEnabled(env({ STORAGE_DRIVER: 'local', BLOB_READ_WRITE_TOKEN: 't' }))).toBe(false)
    expect(
      isBlobUploadsEnabled(env({ STORAGE_DRIVER: 'vercel-blob', BLOB_READ_WRITE_TOKEN: TOKEN })),
    ).toBe(true)
  })

  it('dựng URL store theo access, key bắt đầu uploads/', () => {
    const base = { BLOB_READ_WRITE_TOKEN: TOKEN }
    expect(buildBlobUploadUrl(['avatars', '1 a.jpg'], env(base))).toBe(
      'https://s1.public.blob.vercel-storage.com/uploads/avatars/1%20a.jpg',
    )
    expect(buildBlobUploadUrl(['products', 'p.png'], env({ ...base, BLOB_ACCESS: 'private' }))).toBe(
      'https://s1.private.blob.vercel-storage.com/uploads/products/p.png',
    )
    expect(buildBlobUploadUrl(['x'], env({ BLOB_READ_WRITE_TOKEN: 'bad' }))).toBeNull()
  })
})
