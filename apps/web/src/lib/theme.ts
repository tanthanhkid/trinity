"use client"

import { useCallback, useSyncExternalStore } from "react"
import { readUiPref, writeUiPref } from "@/lib/ui-pref-storage"
import { THEME_STORAGE_KEY } from "@/lib/theme-script"

/**
 * Sáng / tối của giao diện. Nguồn sự thật là class `dark` trên `<html>`:
 * Tailwind (`@custom-variant dark`) và khối `html:root[data-ui="app"].dark` của
 * `styles/app-tokens.css` đều đọc class đó.
 *
 * Lựa chọn lưu ở localStorage (`trinity-theme` = "light" | "dark"); chưa chọn thì
 * theo hệ điều hành. Script chống nháy `THEME_INIT_SCRIPT` (`lib/theme-script.ts`) chạy trong <head> của
 * `app/layout.tsx` gắn class TRƯỚC khi vẽ trang đầu tiên.
 */
export type ThemeChoice = "light" | "dark"

export { THEME_STORAGE_KEY }
const THEME_EVENT = "trinity:theme-change"

function systemPrefersDark(): boolean {
  try {
    return window.matchMedia("(prefers-color-scheme: dark)").matches
  } catch {
    return false
  }
}

function readResolved(): ThemeChoice {
  const stored = readUiPref(THEME_STORAGE_KEY)
  if (stored === "light" || stored === "dark") return stored
  return systemPrefersDark() ? "dark" : "light"
}

function applyTheme(theme: ThemeChoice): void {
  const root = document.documentElement
  root.classList.toggle("dark", theme === "dark")
  root.style.colorScheme = theme
}

export function setTheme(theme: ThemeChoice): void {
  writeUiPref(THEME_STORAGE_KEY, theme)
  applyTheme(theme)
  window.dispatchEvent(new Event(THEME_EVENT))
}

function subscribe(onChange: () => void): () => void {
  window.addEventListener(THEME_EVENT, onChange)
  window.addEventListener("storage", onChange)
  const mql = window.matchMedia?.("(prefers-color-scheme: dark)")
  const onSystem = () => {
    // Chỉ theo hệ điều hành khi người dùng CHƯA tự chọn.
    if (!readUiPref(THEME_STORAGE_KEY)) applyTheme(readResolved())
    onChange()
  }
  mql?.addEventListener?.("change", onSystem)
  return () => {
    window.removeEventListener(THEME_EVENT, onChange)
    window.removeEventListener("storage", onChange)
    mql?.removeEventListener?.("change", onSystem)
  }
}

/** Server không biết lựa chọn ⇒ coi là sáng; client đồng bộ lại ngay sau hydrate. */
function readOnServer(): ThemeChoice {
  return "light"
}

export function useTheme(): { theme: ThemeChoice; setTheme: (t: ThemeChoice) => void; toggleTheme: () => void } {
  const theme = useSyncExternalStore(subscribe, readResolved, readOnServer)
  const toggleTheme = useCallback(() => setTheme(readResolved() === "dark" ? "light" : "dark"), [])
  return { theme, setTheme, toggleTheme }
}
