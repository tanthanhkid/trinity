import { SessionHandoff } from "../_components/session-handoff"

/** Link đăng nhập trong thư: `/auth/email#token=…` (#675). */
export default function EmailLinkPage() {
  return <SessionHandoff kind="email" />
}
