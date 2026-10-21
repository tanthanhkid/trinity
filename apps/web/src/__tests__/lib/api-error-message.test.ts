import { AxiosError, AxiosHeaders } from "axios"
import { describe, expect, it } from "vitest"
import { getApiErrorMessage } from "@/lib/api-client"
import { describeError, errorKind, ERROR_MESSAGES, serverSentence } from "@/lib/error-messages"

const err = (data: unknown, status = 400) =>
  new AxiosError(`Request failed with status code ${status}`, "ERR_BAD_REQUEST", undefined, undefined, {
    data,
    status,
    statusText: "",
    headers: {},
    config: { headers: new AxiosHeaders() },
  })

describe("getApiErrorMessage", () => {
  it("NestJS: lấy câu tiếng Việt ở message, không lấy tên mã HTTP ở error", () => {
    expect(getApiErrorMessage(err({ statusCode: 400, message: "Kênh này chưa có bài đã đăng để gỡ.", error: "Bad Request" }), "x")).toBe("Kênh này chưa có bài đã đăng để gỡ.")
    expect(getApiErrorMessage(err({ statusCode: 400, message: ["Chọn ít nhất một kênh", "Bài cần có nội dung"], error: "Bad Request" }), "x")).toBe("Chọn ít nhất một kênh; Bài cần có nội dung")
  })

  it("error là câu giải thích tiếng Việt ⇒ giữ; lỗi không phải từ máy chủ ⇒ giữ câu màn hình", () => {
    expect(getApiErrorMessage(err({ error: "Tệp quá lớn (tối đa 200 MB)." }), "x")).toBe("Tệp quá lớn (tối đa 200 MB).")
    expect(getApiErrorMessage(new Error("boom"), "fb")).toBe("fb")
  })

  it("chữ tiếng Anh / mã lỗi của máy chủ KHÔNG hiện ra — thay bằng câu theo loại lỗi", () => {
    expect(getApiErrorMessage(err({ error: "Bad Request" }), "Không tạo được bài đăng")).toBe(
      "Không tạo được bài đăng: thông tin chưa hợp lệ. Kiểm tra lại các ô đã nhập.",
    )
    expect(getApiErrorMessage(err({ message: "Internal server error" }, 500), "Không lưu được, vui lòng thử lại")).toBe(
      `Không lưu được: máy chủ đang gặp sự cố. ${ERROR_MESSAGES.server.hint}`,
    )
    expect(getApiErrorMessage(err({ error: "CONTACT_NOT_FOUND" }, 404), "Không mở được khách")).toContain("không tìm thấy dữ liệu")
    expect(getApiErrorMessage(err({ message: "ThrottlerException: Too Many Requests" }, 429), "Không gửi được")).toContain("thao tác hơi nhanh")
  })
})

describe("bảng thông điệp lỗi", () => {
  it("phân loại theo mã trạng thái / mạng", () => {
    const cases: [number, string][] = [[401, "session"], [403, "forbidden"], [404, "notFound"], [409, "conflict"], [413, "tooLarge"], [422, "validation"], [429, "rateLimited"], [500, "server"], [502, "maintenance"], [503, "maintenance"], [504, "timeout"]]
    for (const [s, k] of cases) expect(errorKind(err(undefined, s))).toBe(k)
    expect(errorKind(new AxiosError("Network Error", "ERR_NETWORK"))).toBe("network")
    expect(errorKind(new AxiosError("timeout", "ECONNABORTED"))).toBe("timeout")
    expect(errorKind(new Error("x"))).toBe("unknown")
  })

  it("mọi câu là tiếng Việt, có cách sửa, không lộ kỹ thuật", () => {
    for (const { title, hint } of Object.values(ERROR_MESSAGES)) {
      const s = `${title}. ${hint}`
      expect(s).toMatch(/[àáảãạăâđèéêìíòóôơùúưỳý]/i)
      expect(s).not.toMatch(/\b(MCP|HTTP|API|error|server|token|[45]\d\d)\b/i)
    }
  })

  it("serverSentence chỉ nhận câu có dấu tiếng Việt; describeError không có câu màn hình ⇒ câu đầy đủ", () => {
    expect(serverSentence(err({ message: "email must be an email" }))).toBeNull()
    expect(serverSentence(err({ message: "Số điện thoại đã tồn tại" }))).toBe("Số điện thoại đã tồn tại")
    expect(describeError(err(undefined, 403))).toBe(`${ERROR_MESSAGES.forbidden.title}. ${ERROR_MESSAGES.forbidden.hint}`)
  })
})

describe("câu màn hình đã tự giải thích", () => {
  it("lỗi dữ liệu ⇒ giữ nguyên câu màn hình; lỗi máy chủ ⇒ vẫn nói nguyên nhân thật", () => {
    const action = "Không đọc được file. Kiểm tra đúng mẫu Excel rồi tải lại"
    expect(describeError(err({}, 400), action)).toBe(action)
    expect(describeError(err({}, 500), action)).toContain("máy chủ đang gặp sự cố")
  })
})

describe("ghép câu không lặp dấu câu / lặp lời khuyên (Codex P2 #52)", () => {
  it("câu màn hình kết thúc bằng dấu chấm hoặc 'thử bấm lại sau ít giây' ⇒ không ra '.:'", () => {
    expect(describeError(err({}, 500), "Chưa kiểm được, bạn thử bấm lại sau ít giây.")).toBe(
      `Chưa kiểm được: máy chủ đang gặp sự cố. ${ERROR_MESSAGES.server.hint}`,
    )
    expect(describeError(err({}, 500), "Không lấy được thông tin tài khoản TikTok.")).toBe(
      `Không lấy được thông tin tài khoản TikTok: máy chủ đang gặp sự cố. ${ERROR_MESSAGES.server.hint}`,
    )
    expect(describeError(err({}, 500), "x.")).not.toContain(".:")
  })
})
