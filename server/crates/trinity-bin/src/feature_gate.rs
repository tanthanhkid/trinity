//! Cổng tính năng của tổ chức cho `ApiRouter` (`OrgFeatureGuard` → `OrgFeaturesService.isEnabled`): đọc cờ đã áp gói qua
//! `mod_settings::features::get`; mọi lỗi đọc coi là bật (fail-open, như bản TS).

use trinity_db::{CompanyRef, Db};
use trinity_http::router::{FeatureFuture, OrgFeatureGate};

pub struct OrgGate {
    pub db: Db,
    pub multi_tenant: bool,
}

impl OrgFeatureGate for OrgGate {
    fn enabled<'a>(&'a self, company: CompanyRef, feature: &'a str) -> FeatureFuture<'a> {
        Box::pin(async move {
            let Ok(tenant) = self.db.tenant(company).await else {
                return true;
            };
            let Ok(mut conn) = tenant.acquire().await else {
                return true;
            };
            let ctx = mod_settings::Ctx {
                company_id: self.multi_tenant.then_some(company.id()),
            };
            match mod_settings::features::get(&mut conn, ctx).await {
                Ok(flags) => flags
                    .0
                    .iter()
                    .find(|(key, _)| *key == feature)
                    .is_none_or(|(_, on)| on.unwrap_or(true)),
                Err(_) => true,
            }
        })
    }
}
