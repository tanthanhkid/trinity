#!/usr/bin/env bash
# Bọc một tiến trình máy chủ để đo bộ nhớ đỉnh `VmHWM` (kB, /proc/<pid>/status) của chính nó (issue K31).
# Dùng làm SERVER_CMD của bộ hợp đồng: ["bash", ".github/scripts/vmhwm-wrap.sh", "/đường/dẫn/trinity", "serve"].
# Biến: VMHWM_LABEL (nhãn dòng kết quả), VMHWM_OUT (tệp nối thêm dòng "<nhãn> <kB>").
# Bộ chạy tắt máy chủ bằng SIGTERM: bắt tín hiệu, đọc VmHWM lúc tiến trình còn sống (sau khi thoát /proc không còn), rồi chuyển tiếp.
set -u
label="${VMHWM_LABEL:-server}"
out="${VMHWM_OUT:-/tmp/vmhwm.txt}"
"$@" &
child=$!
last=""
reported=0

sample() {
  local v
  v=$(awk '/^VmHWM:/ {print $2}' "/proc/$child/status" 2>/dev/null || true)
  if [ -n "$v" ]; then last="$v"; fi
}

report() {
  if [ "$reported" -eq 1 ]; then return; fi
  reported=1
  if [ -n "$last" ]; then
    echo "$label $last" >>"$out"
    echo "[vmhwm] $label: VmHWM=${last} kB"
  else
    echo "[vmhwm] $label: không đọc được VmHWM" >&2
  fi
}

on_term() {
  sample
  report
  kill -TERM "$child" 2>/dev/null
  wait "$child"
  exit $?
}
trap on_term TERM INT

while kill -0 "$child" 2>/dev/null; do
  sample
  sleep 0.5 &
  wait $! 2>/dev/null
done
wait "$child"
rc=$?
report
exit "$rc"
