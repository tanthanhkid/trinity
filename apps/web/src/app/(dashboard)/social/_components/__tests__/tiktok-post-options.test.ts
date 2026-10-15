import { describe, expect, it } from "vitest"
import { EMPTY_TIKTOK_CHOICE, tiktokBlocker, tiktokOptionsOf } from "../tiktok-post-options"
import type { TiktokCreatorInfo } from "@/hooks/use-social"

const info: TiktokCreatorInfo = {
  nickname: "Tiệm bánh",
  username: "tiembanh",
  avatar_url: null,
  privacy_level_options: ["SELF_ONLY", "PUBLIC_TO_EVERYONE"],
  comment_disabled: false,
  duet_disabled: true,
  stitch_disabled: false,
  max_video_post_duration_sec: 60,
}

describe("TikTok: điều kiện đăng theo UX guidelines", () => {
  it("không chọn sẵn quyền xem, công tắc mặc định tắt", () => {
    expect(EMPTY_TIKTOK_CHOICE.privacy).toBeUndefined()
    expect(tiktokBlocker(EMPTY_TIKTOK_CHOICE, info, 10)).toMatch(/Chọn ai được xem/)
    expect(tiktokOptionsOf({ ...EMPTY_TIKTOK_CHOICE, privacy: "SELF_ONLY" }, info, 10)).toMatchObject({
      allow_comment: false, allow_duet: false, allow_stitch: false, brand_organic: false, brand_content: false,
    })
  })

  it("chưa có creator_info hoặc đang đo thời lượng thì chưa cho đăng", () => {
    const c = { ...EMPTY_TIKTOK_CHOICE, privacy: "SELF_ONLY" as const }
    expect(tiktokBlocker(c, undefined, 10)).toMatch(/thông tin tài khoản/)
    expect(tiktokBlocker(c, info, undefined)).toMatch(/đo thời lượng/)
    expect(tiktokBlocker(c, info, 10)).toBeNull()
  })

  it("quyền xem đã chọn mà creator_info mới không còn cho thì phải chọn lại", () => {
    const c = { ...EMPTY_TIKTOK_CHOICE, privacy: "MUTUAL_FOLLOW_FRIENDS" as const }
    expect(tiktokBlocker(c, info, 10)).toMatch(/chọn lại/)
  })

  it("video quá giới hạn tài khoản bị chặn", () => {
    expect(tiktokBlocker({ ...EMPTY_TIKTOK_CHOICE, privacy: "SELF_ONLY" }, info, 61)).toMatch(/tối đa 60 giây/)
  })

  it("công bố thương mại: phải chọn ít nhất một loại; có thương hiệu thì không để Chỉ mình tôi", () => {
    const base = { ...EMPTY_TIKTOK_CHOICE, privacy: "SELF_ONLY" as const, commercial: true }
    expect(tiktokBlocker(base, info, 10)).toMatch(/ít nhất một loại/)
    expect(tiktokBlocker({ ...base, brandOrganic: true }, info, 10)).toBeNull()
    expect(tiktokBlocker({ ...base, brandContent: true }, info, 10)).toMatch(/Chỉ mình tôi/)
  })

  it("tương tác tài khoản đã tắt thì không gửi bật; tắt công bố thì bỏ cờ thương hiệu", () => {
    const c = { ...EMPTY_TIKTOK_CHOICE, privacy: "PUBLIC_TO_EVERYONE" as const, comment: true, duet: true, brandOrganic: true }
    expect(tiktokOptionsOf(c, info, 10)).toMatchObject({ allow_comment: true, allow_duet: false, brand_organic: false })
  })
})
