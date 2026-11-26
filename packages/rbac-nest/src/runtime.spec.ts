import { runInBackground } from './runtime'

describe('runInBackground', () => {
  it('task vẫn chạy, không chặn người gọi', async () => {
    const task = jest.fn().mockResolvedValue(1)
    expect(runInBackground(task)).toBeUndefined()
    await new Promise((r) => setImmediate(r))
    expect(task).toHaveBeenCalled()
  })

  it('task ném lỗi → chuyển cho onError, không unhandled rejection', async () => {
    const onError = jest.fn()
    runInBackground(async () => { throw new Error('x') }, onError)
    await new Promise((r) => setImmediate(r))
    expect(onError).toHaveBeenCalledWith(expect.objectContaining({ message: 'x' }))
  })

  it('task đồng bộ ném lỗi cũng được bắt', async () => {
    const onError = jest.fn()
    runInBackground(() => { throw new Error('sync') }, onError)
    await new Promise((r) => setImmediate(r))
    expect(onError).toHaveBeenCalled()
  })

  it('onError tự ném lỗi cũng bị nuốt', async () => {
    runInBackground(async () => { throw new Error('x') }, () => { throw new Error('y') })
    await new Promise((r) => setImmediate(r))
  })
})
