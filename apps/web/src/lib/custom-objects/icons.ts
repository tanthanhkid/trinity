import {
  Baby, Banknote, BookOpen, Briefcase, Building2, CalendarCheck, Car, ClipboardList, CreditCard, Dumbbell,
  FileText, Folder, GraduationCap, HeartPulse, House, MapPin, Package, Phone, Plane, Receipt, Shapes, ShoppingCart,
  Star, Stethoscope, Store, Tag, Truck, UserRound, Users, Utensils, Wallet, Wrench, type LucideIcon,
} from "lucide-react"

/** Whitelist icon cho thực thể tuỳ biến — khớp `CUSTOM_ICONS` ở BE; tên lạ → `Shapes`. */
export const CUSTOM_ICON_MAP: Record<string, LucideIcon> = {
  shapes: Shapes, users: Users, "user-round": UserRound, "graduation-cap": GraduationCap, "book-open": BookOpen,
  receipt: Receipt, wallet: Wallet, "clipboard-list": ClipboardList, "calendar-check": CalendarCheck, package: Package,
  store: Store, "building-2": Building2, briefcase: Briefcase, "heart-pulse": HeartPulse, stethoscope: Stethoscope,
  car: Car, home: House, wrench: Wrench, truck: Truck, "shopping-cart": ShoppingCart, "file-text": FileText,
  folder: Folder, tag: Tag, star: Star, "map-pin": MapPin, phone: Phone, "credit-card": CreditCard, banknote: Banknote,
  baby: Baby, utensils: Utensils, dumbbell: Dumbbell, plane: Plane,
}

export const CUSTOM_ICON_NAMES = Object.keys(CUSTOM_ICON_MAP)

export function customIcon(name: string | null | undefined): LucideIcon {
  return (name && CUSTOM_ICON_MAP[name]) || Shapes
}
