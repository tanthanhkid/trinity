/**
 * Cảnh báo khởi động khi chạy nhiều tiến trình API (PM2 `instances > 1` / cluster). Từ G12b trạng thái RAM (quyền, blacklist,
 * phiên, cache đếm, chuông, lỗi Graph) đã đồng bộ qua Postgres NOTIFY, nhưng còn hai thứ chưa chia sẻ: job nền chưa phối hợp
 * giữa các tiến trình Node (mỗi tiến trình tự chạy lịch của nó) và giới hạn tốc độ đếm riêng từng tiến trình (nhân lên theo số
 * worker). Rỗng nếu chạy một tiến trình.
 */
export function clusterModeWarnings(env: NodeJS.ProcessEnv = process.env): string[] {
  const idx = Number(env.NODE_APP_INSTANCE ?? env.pm_id ?? '')
  const instances = Number(env.instances ?? env.PM2_INSTANCES ?? '')
  const inCluster = (Number.isFinite(idx) && (env.NODE_APP_INSTANCE ?? env.pm_id) !== undefined && idx > 0) || (Number.isFinite(instances) && instances > 1)
  if (!inCluster) return []
  return [
    'Phát hiện chạy nhiều tiến trình API (cluster PM2, instances>1). Trạng thái RAM đã đồng bộ qua Postgres NOTIFY (G12b), ' +
      'nhưng job nền CHƯA phối hợp giữa các tiến trình Node (mỗi tiến trình tự chạy lịch: có thể chạy lặp) và giới hạn tốc độ ' +
      '(MCP, API công khai, đăng nhập) đếm riêng từng tiến trình nên hạn mức hiệu dụng nhân lên theo số worker. ' +
      'Giữ instances: 1 cho API Node trừ khi chạy kèm bản Rust theo tệp sở hữu job. Xem docs/deployment.md.',
  ]
}
