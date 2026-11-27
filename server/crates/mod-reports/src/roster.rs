//! `GET /reports/dashboard-filter-roster`: danh sách Phòng KD / Team / Nhân viên cho bộ lọc Tổng quan (chuyển từ
//! `dashboard-filter-roster.service.ts`). Cấp bậc suy từ CHIỀU CAO trong cây `manager_id`: lá = nhân viên, cha của lá = team,
//! cao hơn = phòng. Chỉ người nằm trong phạm vi `reports.overview` của người gọi.

use std::collections::{BTreeMap, BTreeSet};

use serde_json::{Value, json};
use trinity_kernel::error::HttpError;
use trinity_rbac::OwnerIds;

use crate::filter::can_use_filter;
use crate::{Actor, Ctx, R, db};

/// Chiều cao cây con của từng người (0 = lá); chống vòng bằng tập đang duyệt.
pub fn heights(rows: &[(i32, Option<i32>)]) -> BTreeMap<i32, i32> {
    let mut children: BTreeMap<i32, Vec<i32>> = BTreeMap::new();
    for (id, mgr) in rows {
        if let Some(m) = mgr {
            children.entry(*m).or_default().push(*id);
        }
    }
    fn walk(
        id: i32,
        path: &mut BTreeSet<i32>,
        children: &BTreeMap<i32, Vec<i32>>,
        memo: &mut BTreeMap<i32, i32>,
    ) -> i32 {
        if let Some(h) = memo.get(&id) {
            return *h;
        }
        let mut h = 0;
        path.insert(id);
        for c in children.get(&id).into_iter().flatten() {
            if !path.contains(c) {
                h = h.max(1 + walk(*c, path, children, memo));
            }
        }
        path.remove(&id);
        memo.insert(id, h);
        h
    }
    let mut memo = BTreeMap::new();
    for (id, _) in rows {
        walk(*id, &mut BTreeSet::new(), &children, &mut memo);
    }
    memo
}

pub async fn get(ctx: &Ctx, actor: &Actor) -> R<Value> {
    if !can_use_filter(actor) {
        return Err(HttpError::forbidden("Không có quyền dùng bộ lọc Tổng quan").into());
    }
    let owner = ctx
        .owner_ids(actor, "reports.overview")
        .await?
        .unwrap_or(OwnerIds::Ids(Vec::new()));
    let mut c = ctx.conn(actor.company).await?;
    let rows: Vec<(i32, String, Option<i32>)> =
        sqlx::query_as("SELECT id, full_name, manager_id FROM users WHERE deleted_at IS NULL AND status = 'active' ORDER BY full_name ASC")
            .fetch_all(&mut *c)
            .await
            .map_err(db)?;
    let tree: Vec<(i32, Option<i32>)> = rows.iter().map(|r| (r.0, r.2)).collect();
    let height = heights(&tree);
    let pick = |m: &dyn Fn(i32) -> bool| -> Vec<Value> {
        rows.iter()
            .filter(|r| match &owner {
                OwnerIds::All => true,
                OwnerIds::Ids(v) => v.contains(&r.0),
            })
            .filter(|r| m(height.get(&r.0).copied().unwrap_or(0)))
            .map(|r| json!({ "id": r.0, "full_name": r.1, "manager_id": r.2 }))
            .collect()
    };
    Ok(json!({ "dept_heads": pick(&|h| h >= 2), "team_leads": pick(&|h| h == 1), "sales": pick(&|h| h == 0) }))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn chieu_cao() {
        // 1 → 2 → 4; 1 → 3; 5 độc lập; vòng 6 ↔ 7.
        let rows = [
            (1, None),
            (2, Some(1)),
            (3, Some(1)),
            (4, Some(2)),
            (5, None),
            (6, Some(7)),
            (7, Some(6)),
        ];
        let h = heights(&rows);
        assert_eq!((h[&1], h[&2], h[&3], h[&4], h[&5]), (2, 1, 0, 0, 0));
        assert!(h.contains_key(&6) && h.contains_key(&7));
    }
}
