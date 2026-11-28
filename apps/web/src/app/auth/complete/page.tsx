import { SessionHandoff } from "../_components/session-handoff"

/** Sau Google: máy chủ chuyển về `/auth/complete#ticket=…&next=…` (#675). */
export default function LoginCompletePage() {
  return <SessionHandoff kind="ticket" />
}
