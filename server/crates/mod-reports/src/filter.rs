//! Bộ lọc Phòng/Team/Nhân viên của màn Tổng quan (chuyển từ `dashboard-overview.filter.ts` và `.scope.ts`). Bộ lọc chỉ có
//! hiệu lực với người có `reports.overview` phạm vi từ `team` trở lên, và luôn nằm TRONG phạm vi của người gọi.

use std::collections::{BTreeMap, BTreeSet};

use serde_json::Value;
use sqlx::PgConnection;
use trinity_rbac::{OwnerIds, Scope, can};

use crate::{Actor, R, db};

/// `DashboardFilterQuery` đã qua K15: ba mã tuỳ chọn.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq)]
pub struct Filter {
    pub dept_head_id: Option<i64>,
    pub team_lead_id: Option<i64>,
    pub user_id: Option<i64>,
}

impl Filter {
    pub fn from_validated(v: &Value) -> Self {
        let id = |k: &str| v.get(k).and_then(Value::as_i64);
        Self {
            dept_head_id: id("dept_head_id"),
            team_lead_id: id("team_lead_id"),
            user_id: id("user_id"),
        }
    }

    fn any(&self) -> bool {
        self.dept_head_id.is_some() || self.team_lead_id.is_some() || self.user_id.is_some()
    }
}

pub fn can_use_filter(actor: &Actor) -> bool {
    can(&actor.grants, "reports.overview", Some(Scope::Team))
}

/// Phần của khoá cache theo bộ lọc (`''` khi người gọi không dùng được bộ lọc).
pub fn cache_key(actor: &Actor, f: &Filter) -> String {
    if !can_use_filter(actor) {
        return String::new();
    }
    format!(
        "{}.{}.{}",
        f.dept_head_id.unwrap_or(0),
        f.team_lead_id.unwrap_or(0),
        f.user_id.unwrap_or(0)
    )
}

/// `loadChildrenMap`: người chưa bị xoá vĩnh viễn, theo `manager_id`.
pub async fn load_children(conn: &mut PgConnection) -> R<BTreeMap<i32, Vec<i32>>> {
    let rows: Vec<(i32, Option<i32>)> =
        sqlx::query_as("SELECT id, manager_id FROM users WHERE deleted_at IS NULL ORDER BY id")
            .fetch_all(&mut *conn)
            .await
            .map_err(db)?;
    let mut m: BTreeMap<i32, Vec<i32>> = BTreeMap::new();
    for (id, mgr) in rows {
        if let Some(mgr) = mgr {
            m.entry(mgr).or_default().push(id);
        }
    }
    Ok(m)
}

/// Cây con theo chiều rộng (có chống vòng).
pub fn subtree_ids(children: &BTreeMap<i32, Vec<i32>>, id: i32) -> Vec<i32> {
    let mut seen = BTreeSet::from([id]);
    let mut order = vec![id];
    let mut i = 0;
    while i < order.len() {
        for c in children.get(&order[i]).into_iter().flatten() {
            if seen.insert(*c) {
                order.push(*c);
            }
        }
        i += 1;
    }
    order
}

fn intersect(a: &[i32], b: &[i32]) -> Vec<i32> {
    a.iter().copied().filter(|x| b.contains(x)).collect()
}

/// `resolveFilterUserIds`: giao của các điều kiện; `None` khi không lọc (hoặc người gọi không dùng được bộ lọc).
pub async fn resolve_ids(conn: &mut PgConnection, actor: &Actor, f: &Filter) -> R<Option<Vec<i32>>> {
    if !can_use_filter(actor) || !f.any() {
        return Ok(None);
    }
    let children = load_children(conn).await?;
    // Mã ngoài miền i32 không thể là người dùng nào ⇒ điều kiện đó khớp rỗng.
    let mut sets: Vec<Vec<i32>> = Vec::new();
    if let Some(d) = f.dept_head_id {
        sets.push(i32::try_from(d).map(|d| subtree_ids(&children, d)).unwrap_or_default());
    }
    if let Some(t) = f.team_lead_id {
        sets.push(match i32::try_from(t) {
            Ok(t) => std::iter::once(t)
                .chain(children.get(&t).into_iter().flatten().copied())
                .collect(),
            Err(_) => Vec::new(),
        });
    }
    if let Some(u) = f.user_id {
        sets.push(i32::try_from(u).map(|u| vec![u]).unwrap_or_default());
    }
    let mut it = sets.into_iter();
    let first = it.next().unwrap_or_default();
    Ok(Some(it.fold(first, |acc, s| intersect(&acc, &s))))
}

/// `composeScope`: phạm vi của người gọi giao với bộ lọc.
pub fn compose(owner: &OwnerIds, filter: Option<&[i32]>) -> OwnerIds {
    match (owner, filter) {
        (o, None) => o.clone(),
        (OwnerIds::All, Some(f)) => OwnerIds::Ids(f.to_vec()),
        (OwnerIds::Ids(o), Some(f)) => OwnerIds::Ids(intersect(o, f)),
    }
}

/// Điều kiện SQL `(assigned_to = ANY | created_by_id = ANY)` của khách, hoặc `TRUE` với `All`.
pub fn contact_scope_sql(alias: &str, owner: &OwnerIds, ids_param: usize) -> String {
    match owner {
        OwnerIds::All => "TRUE".to_owned(),
        OwnerIds::Ids(_) => {
            format!("({alias}.assigned_to = ANY(${ids_param}) OR {alias}.created_by_id = ANY(${ids_param}))")
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn cay_va_giao() {
        let mut ch: BTreeMap<i32, Vec<i32>> = BTreeMap::new();
        ch.insert(1, vec![2, 3]);
        ch.insert(2, vec![4]);
        ch.insert(4, vec![1]); // vòng: không treo
        assert_eq!(subtree_ids(&ch, 1), [1, 2, 3, 4]);
        assert_eq!(subtree_ids(&ch, 3), [3]);
        assert_eq!(compose(&OwnerIds::All, Some(&[5, 6])), OwnerIds::Ids(vec![5, 6]));
        assert_eq!(
            compose(&OwnerIds::Ids(vec![1, 2, 3]), Some(&[3, 9])),
            OwnerIds::Ids(vec![3])
        );
        assert_eq!(compose(&OwnerIds::Ids(vec![1]), None), OwnerIds::Ids(vec![1]));
        assert_eq!(intersect(&[1, 2, 3], &[2, 3, 4]), [2, 3]);
    }
}
