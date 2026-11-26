//! RBAC (K12, docs/rust/PLAN.md mục 4.7): catalog quyền nhúng từ `server/contracts/rbac.json` (C04), gộp quyền và
//! `can` như `packages/rbac/src/grants.ts`, quyền của người dùng (`PermissionService.grantsFor`), phạm vi
//! own/team/subtree/all (`ScopeService.ownerIds`) và cache RAM 60 giây vô hiệu chéo tiến trình qua `NOTIFY trinity_sync`
//! kind `rbac`.

pub mod cache;
pub mod catalog;
pub mod grants;
pub mod plan;
pub mod scope;
pub mod service;

pub use cache::RbacCache;
pub use catalog::{Catalog, PermissionDef, catalog};
pub use grants::{Grant, Grants, Scope, can, is_subset, merge_grants, normalize_grant, scope_of};
pub use scope::{PhoneMasker, ScopeError, assert_in_scope, mask_phone, push_scope};
pub use service::{GrantsResult, OwnerIds, PermissionService, ScopeService, admin_grants};
