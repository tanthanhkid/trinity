import { setServerErrorReporter, reportServerError } from './server-error-reporter'

afterEach(() => setServerErrorReporter(null))

describe('server error reporter', () => {
  it('no-op khi chưa đăng ký', () => {
    expect(() => reportServerError(new Error('x'), {})).not.toThrow()
  })
  it('gọi reporter với err + ctx', () => {
    const fn = jest.fn()
    setServerErrorReporter(fn)
    const e = new Error('boom')
    reportServerError(e, { status: 500 })
    expect(fn).toHaveBeenCalledWith(e, { status: 500 })
  })
  it('nuốt lỗi của reporter', () => {
    setServerErrorReporter(() => {
      throw new Error('reporter down')
    })
    expect(() => reportServerError(new Error('x'))).not.toThrow()
  })
})
