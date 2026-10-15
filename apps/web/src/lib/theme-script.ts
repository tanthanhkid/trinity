/**
 * Script chống nháy sáng/tối, nhúng vào <head> của `app/layout.tsx` (server
 * component) — vì vậy tách khỏi `lib/theme.ts` ("use client").
 * Gắn class `dark` + `color-scheme` TRƯỚC khi vẽ trang đầu tiên. `?theme=dark|light`
 * trên URL cũng được nhận và nhớ lại (tiện chụp ảnh / gửi link).
 */
export const THEME_STORAGE_KEY = "trinity-theme"

export const THEME_INIT_SCRIPT = `(function(){try{var k='${THEME_STORAGE_KEY}';var q=new URLSearchParams(location.search).get('theme');if(q==='light'||q==='dark'){localStorage.setItem(k,q)}var t=localStorage.getItem(k);var d=t?t==='dark':matchMedia('(prefers-color-scheme: dark)').matches;var r=document.documentElement;r.classList.toggle('dark',d);r.style.colorScheme=d?'dark':'light'}catch(e){}})();`
