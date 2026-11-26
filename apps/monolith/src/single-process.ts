/**
 * Bản TS chỉ hỗ trợ MỘT tiến trình API (G12a bỏ Redis): thu hồi quyền (RbacCache) và giới hạn MCP chỉ có hiệu lực trong
 * tiến trình, nên chạy nhiều worker thì quyền vừa thu hồi còn hiệu lực tới 60 giây ở worker khác và mỗi worker đếm giới
 * hạn riêng. Hàm trả các cảnh báo khi môi trường cho thấy đang chạy cluster (PM2 `instances > 1`); rỗng nếu ổn.
 * Đồng bộ giữa tiến trình làm ở G12b (Postgres NOTIFY).
 */
export function clusterModeWarnings(env: NodeJS.ProcessEnv = process.env): string[] {
  const idx = Number(env.NODE_APP_INSTANCE ?? env.pm_id ?? '')
  const instances = Number(env.instances ?? env.PM2_INSTANCES ?? '')
  const inCluster = (Number.isFinite(idx) && (env.NODE_APP_INSTANCE ?? env.pm_id) !== undefined && idx > 0) || (Number.isFinite(instances) && instances > 1)
  if (!inCluster) return []
  return [
    'Phát hiện chạy nhiều tiến trình API (cluster PM2, instances>1). Bản TS CHỈ hỗ trợ MỘT tiến trình: thu hồi quyền ' +
      'và giới hạn MCP chỉ áp trong từng tiến trình (quyền thu hồi có thể còn hiệu lực tới 60 giây ở tiến trình khác, ' +
      'giới hạn đếm riêng từng worker). Đặt instances: 1 cho tới khi có G12b (Postgres NOTIFY). Xem docs/deployment.md.',
  ]
}
