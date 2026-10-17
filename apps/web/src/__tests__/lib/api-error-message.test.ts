import { AxiosError, AxiosHeaders } from "axios"
import { describe, expect, it } from "vitest"
import { getApiErrorMessage } from "@/lib/api-client"

const err = (data: unknown) =>
  new AxiosError("Request failed with status code 400", "ERR_BAD_REQUEST", undefined, undefined, {
    data,
    status: 400,
    statusText: "Bad Request",
    headers: {},
    config: { headers: new AxiosHeaders() },
  })

describe("getApiErrorMessage", () => {
  it("NestJS: lấy câu tiếng Việt ở message, không lấy tên mã HTTP ở error", () => {
    expect(getApiErrorMessage(err({ statusCode: 400, message: "Kênh này chưa có bài đã đăng để gỡ.", error: "Bad Request" }), "x")).toBe("Kênh này chưa có bài đã đăng để gỡ.")
    expect(getApiErrorMessage(err({ statusCode: 400, message: ["Chọn ít nhất một kênh", "Bài cần có nội dung"], error: "Bad Request" }), "x")).toBe("Chọn ít nhất một kênh; Bài cần có nội dung")
  })

  it("error là câu giải thích riêng ⇒ giữ error; không có gì ⇒ fallback", () => {
    expect(getApiErrorMessage(err({ error: "Tệp quá lớn (tối đa 200 MB)." }), "x")).toBe("Tệp quá lớn (tối đa 200 MB).")
    expect(getApiErrorMessage(err({ error: "Bad Request" }), "x")).toBe("Bad Request")
    expect(getApiErrorMessage(err(undefined), "Không tạo được bài đăng")).toBe("Không tạo được bài đăng")
    expect(getApiErrorMessage(new Error("boom"), "fb")).toBe("fb")
  })
})
