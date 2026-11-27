//! Tham chiếu bản ghi dùng chung giữa mọi bảng (chuyển từ `refs/*.ts`): gắn thẻ @, trường "Liên kết", truy ngược, xem nhanh.
//! Một tham chiếu = `loại:id` (`record:12`, `contact:5`, `deal:3`, `task:9`); hiển thị bằng MÃ (HS001, KH005…) nhưng LƯU
//! bằng id để đổi tiền tố không gãy. MỌI truy vấn lọc theo quyền XEM của người hỏi (bảng tuỳ biến: bảng được thấy + phạm vi
//! `custom_records.view`; khách `contacts.view`; deal `deals.view`; công việc `kanban.view` + bảng kanban được thấy).
//! Không có quyền ⇒ nguồn đó trả rỗng (không lỗi, không lộ có hay không).

use std::collections::HashMap;
use std::sync::LazyLock;

use regex::Regex;
use serde_json::{Map, Value, json};
use sqlx::{PgConnection, Postgres, QueryBuilder, Row};
use trinity_db::models::CustomObject;
use trinity_kernel::vi::{Collation, SQL_FOLD_FROM, SQL_FOLD_TO, compare, escape_like, fold_vi, trim_js};
use trinity_rbac::{OwnerIds, can, push_scope};

use crate::access::{OBJ_COLS, ObjectDef, is_object_visible, load_access, load_visible_object};
use crate::dates::{vn_date, vn_date_time};
use crate::present::{Env, present};
use crate::types::FieldDef;
use crate::{Actor, Ctx, R, db, internal, not_found};

pub const SUGGEST_MAX: i64 = 20;
pub const BACKLINKS_MAX: usize = 50;
/// Số ứng viên tối đa lấy theo tên (khách/deal/việc) trước khi lọc quyền xem.
const NAME_CANDIDATES: i64 = 200;
/// Tiền tố mã của bảng lõi (khớp `CORE_CODE_PREFIXES`).
const CORE: [(RefType, &str); 3] = [(RefType::Contact, "KH"), (RefType::Deal, "DL"), (RefType::Task, "CV")];

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub enum RefType {
    Record,
    Contact,
    Deal,
    Task,
}

impl RefType {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Record => "record",
            Self::Contact => "contact",
            Self::Deal => "deal",
            Self::Task => "task",
        }
    }

    pub fn parse(s: &str) -> Option<Self> {
        [Self::Record, Self::Contact, Self::Deal, Self::Task]
            .into_iter()
            .find(|t| t.as_str() == s)
    }

    fn table_label(self) -> &'static str {
        match self {
            Self::Record => "",
            Self::Contact => "Khách hàng",
            Self::Deal => "Deal",
            Self::Task => "Công việc",
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub struct Ref {
    pub ty: RefType,
    pub id: i32,
}

impl Ref {
    pub fn key(self) -> String {
        format!("{}:{}", self.ty.as_str(), self.id)
    }
}

static REF_RE: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r"^(record|contact|deal|task):([0-9]{1,10})$").expect("regex hợp lệ"));

/// `parseRef`: `loại:id`. Id lớn hơn `int4` không thể có trong DB nên coi như không phải tham chiếu.
pub fn parse_ref(raw: &str) -> Option<Ref> {
    let c = REF_RE.captures(trim_js(raw))?;
    let id = c[2].parse::<i64>().ok().filter(|n| *n > 0)?;
    Some(Ref {
        ty: RefType::parse(&c[1])?,
        id: i32::try_from(id).ok()?,
    })
}

static MENTION: LazyLock<Regex> = LazyLock::new(|| {
    // Phần "không dính sau chữ/số/_/@" và "không dính trước chữ/số/_" kiểm tay (regex không có lookahead).
    Regex::new(r"(?:^|[^@])@([A-Za-z]{2,4})([0-9]{1,9})").expect("regex hợp lệ")
});

fn word_char(c: char) -> bool {
    c.is_alphabetic() || c.is_numeric() || c == '_'
}

/// `formatCode`: 1 thành 001, 1000 thành 1000.
pub fn format_code(prefix: &str, seq: i64) -> String {
    if seq < 1000 {
        format!("{prefix}{seq:03}")
    } else {
        format!("{prefix}{seq}")
    }
}

/// `extractMentionCodes`: `@HS001` (không phân biệt hoa thường), không dính sau chữ/số/@ (email `a@hs001.vn` không tính).
/// Mã CHUẨN (in hoa, đệm 3 số), không trùng, giữ thứ tự xuất hiện, tối đa `max`.
pub fn extract_mention_codes(text: &str, max: usize) -> Vec<String> {
    let mut out: Vec<String> = Vec::new();
    let mut from = 0;
    while let Some(m) = MENTION.captures_at(text, from) {
        let all = m.get(0).expect("khớp");
        // Ký tự đứng ngay trước `@` (nằm trong nhóm 0 trừ khi khớp ở đầu chuỗi) không được là chữ/số/_ .
        let at = text[all.start()..].find('@').map_or(all.start(), |i| all.start() + i);
        let before = text[..at].chars().next_back();
        let after = text[all.end()..].chars().next();
        from = all.end().max(from + 1);
        if before.is_some_and(word_char) || after.is_some_and(word_char) {
            continue;
        }
        let Ok(seq) = m[2].parse::<i64>() else { continue };
        if seq <= 0 {
            continue;
        }
        let code = format_code(&m[1].to_uppercase(), seq);
        if !out.contains(&code) {
            out.push(code);
        }
        if out.len() >= max {
            break;
        }
    }
    out
}

static CODE_RE: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"^([A-Za-z]{2,4})([0-9]{1,9})$").expect("regex hợp lệ"));
static CODE_LIKE: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"^[A-Za-z]{1,4}[0-9]{0,9}$").expect("regex hợp lệ"));

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ParsedCode {
    pub prefix: String,
    pub seq: i32,
    pub code: String,
}

/// `parseCode`: "hs1" / "HS001" thành {HS, 1, HS001}; sai dạng ⇒ `None`.
pub fn parse_code(raw: &str) -> Option<ParsedCode> {
    let c = CODE_RE.captures(trim_js(raw))?;
    let seq = c[2].parse::<i64>().ok().filter(|n| *n > 0)?;
    let prefix = c[1].to_uppercase();
    Some(ParsedCode {
        code: format_code(&prefix, seq),
        seq: i32::try_from(seq).ok()?,
        prefix,
    })
}

/// Một bản ghi người xem ĐƯỢC THẤY.
#[derive(Debug, Clone, PartialEq)]
pub struct RefView {
    pub ty: RefType,
    pub id: i32,
    pub code: Option<String>,
    pub title: String,
    pub table: String,
    pub table_key: Option<String>,
    pub href: Option<String>,
}

impl RefView {
    pub fn reference(&self) -> String {
        Ref {
            ty: self.ty,
            id: self.id,
        }
        .key()
    }

    pub fn to_json(&self) -> Value {
        let mut m = Map::new();
        m.insert("type".into(), json!(self.ty.as_str()));
        m.insert("id".into(), json!(self.id));
        m.insert("ref".into(), json!(self.reference()));
        m.insert("code".into(), json!(self.code));
        m.insert("title".into(), json!(self.title));
        m.insert("table".into(), json!(self.table));
        if let Some(k) = &self.table_key {
            m.insert("table_key".into(), json!(k));
        }
        m.insert("href".into(), json!(self.href));
        Value::Object(m)
    }
}

// ---------------------------------------------------------------------------------------------------------------
// Quyền

/// Phạm vi xem của người hỏi ở 4 nguồn. Lấy TRƯỚC khi giữ kết nối (tránh xin kết nối thứ hai khi đang giữ một).
#[derive(Debug, Clone)]
pub struct Owners {
    pub record: Option<OwnerIds>,
    pub contact: Option<OwnerIds>,
    pub deal: Option<OwnerIds>,
    pub kanban: Option<OwnerIds>,
}

impl Owners {
    pub async fn load(ctx: &Ctx, actor: &Actor) -> R<Self> {
        let get = |p: &'static str| async move {
            ctx.scopes
                .owner_ids(actor.company, actor.user_id, &actor.grants, p)
                .await
                .map_err(trinity_kernel::error::AppError::internal)
        };
        Ok(Self {
            record: get("custom_records.view").await?,
            contact: get("contacts.view").await?,
            deal: get("deals.view").await?,
            kanban: get("kanban.view").await?,
        })
    }
}

#[derive(Debug, Clone)]
pub struct RefAccess {
    pub user_id: i32,
    boards_admin: bool,
    pub objects: HashMap<i32, CustomObject>,
    pub owners: Owners,
    role_ids: Vec<i32>,
}

impl RefAccess {
    /// Bảng tuỳ biến được thấy (theo vai trò) và vai trò của người dùng (cho bảng kanban).
    pub async fn build(conn: &mut PgConnection, actor: &Actor, owners: Owners) -> R<Self> {
        let access = load_access(conn, actor).await?;
        let objs: Vec<CustomObject> = sqlx::query_as(sqlx::AssertSqlSafe(format!(
            "SELECT {OBJ_COLS} FROM custom_objects WHERE deleted_at IS NULL ORDER BY id LIMIT 200"
        )))
        .fetch_all(&mut *conn)
        .await
        .map_err(db)?;
        let objects = objs
            .into_iter()
            .filter(|o| is_object_visible(o, &access))
            .map(|o| (o.id, o))
            .collect();
        Ok(Self {
            user_id: actor.user_id,
            boards_admin: can(&actor.grants, "kanban.boards", None),
            objects,
            owners,
            role_ids: access.role_ids,
        })
    }
}

// ---------------------------------------------------------------------------------------------------------------
// Nguồn bản ghi (mọi truy vấn đã lọc quyền xem)

type Pusher<'a> = &'a (dyn Fn(&mut QueryBuilder<Postgres>) + Sync);

#[derive(Clone, Copy)]
enum Pred<'a> {
    Ids(&'a [i32]),
    CodesIn(&'a [String]),
    CodePrefix(&'a str),
}

fn push_pred(qb: &mut QueryBuilder<Postgres>, p: Pred<'_>) {
    match p {
        Pred::Ids(ids) => {
            qb.push("id = ANY(").push_bind(ids.to_vec()).push(")");
        }
        Pred::CodesIn(c) => {
            qb.push("code = ANY(").push_bind(c.to_vec()).push(")");
        }
        Pred::CodePrefix(q) => {
            qb.push("code LIKE ")
                .push_bind(format!("{}%", escape_like(q)))
                .push(" ESCAPE '\\'");
        }
    }
}

/// Bản ghi tuỳ biến thấy được (kèm `code_seq` để đối chiếu mã).
pub struct RecHit {
    pub view: RefView,
    pub object_id: i32,
    pub code_seq: Option<i32>,
}

/// Bản ghi tuỳ biến khớp `cond` (SQL trên `custom_records`), chỉ bảng được thấy + trong phạm vi xem.
async fn find_records(
    conn: &mut PgConnection,
    acc: &RefAccess,
    cond: Pusher<'_>,
    limit: i64,
    order: Pusher<'_>,
) -> R<Vec<RecHit>> {
    let Some(owners) = &acc.owners.record else {
        return Ok(Vec::new());
    };
    if acc.objects.is_empty() || limit <= 0 {
        return Ok(Vec::new());
    }
    let objs: Vec<i32> = acc.objects.keys().copied().collect();
    let mut qb = QueryBuilder::<Postgres>::new(
        "SELECT id, code, title, object_id, code_seq FROM custom_records WHERE (deleted_at IS NULL) AND (object_id = ANY(",
    );
    qb.push_bind(objs).push(")) AND (");
    push_scope(&mut qb, owners, &["owner_id", "created_by"]);
    qb.push(") AND (");
    cond(&mut qb);
    qb.push(") ORDER BY ");
    order(&mut qb);
    qb.push(" LIMIT ").push_bind(limit);
    let rows = qb.build().fetch_all(&mut *conn).await.map_err(db)?;
    let mut out = Vec::with_capacity(rows.len());
    for r in &rows {
        let object_id: i32 = r.try_get("object_id").map_err(db)?;
        let id: i32 = r.try_get("id").map_err(db)?;
        let title: Option<String> = r.try_get("title").map_err(db)?;
        let Some(o) = acc.objects.get(&object_id) else { continue };
        out.push(RecHit {
            view: RefView {
                ty: RefType::Record,
                id,
                code: r.try_get("code").map_err(db)?,
                title: title.unwrap_or_else(|| format!("{} #{id}", o.label)),
                table: o.label.clone(),
                table_key: Some(o.key.clone()),
                href: Some(format!("/x/{}/{id}", o.key)),
            },
            object_id,
            code_seq: r.try_get("code_seq").map_err(db)?,
        });
    }
    Ok(out)
}

fn views(hits: Vec<RecHit>) -> Vec<RefView> {
    hits.into_iter().map(|h| h.view).collect()
}

async fn find_contacts(conn: &mut PgConnection, acc: &RefAccess, pred: Pred<'_>, limit: i64) -> R<Vec<RefView>> {
    let Some(owners) = &acc.owners.contact else {
        return Ok(Vec::new());
    };
    if limit <= 0 {
        return Ok(Vec::new());
    }
    let mut qb =
        QueryBuilder::<Postgres>::new("SELECT id, code, full_name FROM contacts WHERE (deleted_at IS NULL) AND (");
    push_pred(&mut qb, pred);
    qb.push(") AND (");
    push_scope(&mut qb, owners, &["assigned_to", "created_by_id"]);
    qb.push(") ORDER BY id DESC LIMIT ").push_bind(limit);
    let rows = qb.build().fetch_all(&mut *conn).await.map_err(db)?;
    let mut out = Vec::new();
    for r in &rows {
        let id: i32 = r.try_get("id").map_err(db)?;
        let name: Option<String> = r.try_get("full_name").map_err(db)?;
        out.push(RefView {
            ty: RefType::Contact,
            id,
            code: r.try_get("code").map_err(db)?,
            title: name.filter(|n| !n.is_empty()).unwrap_or_else(|| format!("Khách #{id}")),
            table: RefType::Contact.table_label().into(),
            table_key: None,
            href: Some(format!("/contacts/{id}")),
        });
    }
    Ok(out)
}

async fn find_deals(conn: &mut PgConnection, acc: &RefAccess, pred: Pred<'_>, limit: i64) -> R<Vec<RefView>> {
    let Some(owners) = &acc.owners.deal else {
        return Ok(Vec::new());
    };
    if limit <= 0 {
        return Ok(Vec::new());
    }
    let mut qb = QueryBuilder::<Postgres>::new("SELECT id, code, title, contact_id FROM deals WHERE (");
    push_pred(&mut qb, pred);
    qb.push(") AND (");
    push_scope(&mut qb, owners, &["assigned_to", "created_by"]);
    qb.push(") ORDER BY id DESC LIMIT ").push_bind(limit);
    let rows = qb.build().fetch_all(&mut *conn).await.map_err(db)?;
    let mut out = Vec::new();
    for r in &rows {
        let id: i32 = r.try_get("id").map_err(db)?;
        let title: Option<String> = r.try_get("title").map_err(db)?;
        let contact: Option<i32> = r.try_get("contact_id").map_err(db)?;
        out.push(RefView {
            ty: RefType::Deal,
            id,
            code: r.try_get("code").map_err(db)?,
            title: title.filter(|n| !n.is_empty()).unwrap_or_else(|| format!("Deal #{id}")),
            table: RefType::Deal.table_label().into(),
            table_key: None,
            href: contact.map(|c| format!("/contacts/{c}")),
        });
    }
    Ok(out)
}

async fn find_tasks(conn: &mut PgConnection, acc: &RefAccess, pred: Pred<'_>, limit: i64) -> R<Vec<RefView>> {
    let Some(owners) = &acc.owners.kanban else {
        return Ok(Vec::new());
    };
    if limit <= 0 {
        return Ok(Vec::new());
    }
    let mut qb =
        QueryBuilder::<Postgres>::new("SELECT id, code, title FROM kanban_cards WHERE (deleted_at IS NULL) AND (");
    push_pred(&mut qb, pred);
    qb.push(") AND (");
    match owners {
        OwnerIds::All => {
            qb.push("TRUE");
        }
        OwnerIds::Ids(ids) => {
            qb.push("created_by = ANY(")
                .push_bind(ids.clone())
                .push(") OR assignee_id = ANY(")
                .push_bind(ids.clone());
            qb.push(") OR EXISTS (SELECT 1 FROM kanban_card_assignees a WHERE a.card_id = kanban_cards.id AND a.user_id = ANY(");
            qb.push_bind(ids.clone()).push("))");
        }
    }
    qb.push(") AND EXISTS (SELECT 1 FROM kanban_boards b WHERE b.id = kanban_cards.board_id AND b.deleted_at IS NULL");
    if !acc.boards_admin {
        qb.push(
            " AND b.is_active AND (coalesce(cardinality(b.visibility_role_ids), 0) = 0 OR b.visibility_role_ids && ",
        );
        qb.push_bind(acc.role_ids.clone()).push("::int4[])");
    }
    qb.push(") ORDER BY id DESC LIMIT ").push_bind(limit);
    let rows = qb.build().fetch_all(&mut *conn).await.map_err(db)?;
    let mut out = Vec::new();
    for r in &rows {
        let id: i32 = r.try_get("id").map_err(db)?;
        let title: String = r.try_get("title").map_err(db)?;
        out.push(RefView {
            ty: RefType::Task,
            id,
            code: r.try_get("code").map_err(db)?,
            title: if title.is_empty() {
                format!("Công việc #{id}")
            } else {
                title
            },
            table: RefType::Task.table_label().into(),
            table_key: None,
            href: Some(format!("/kanban?card={id}")),
        });
    }
    Ok(out)
}

// ---------------------------------------------------------------------------------------------------------------
// Tra cứu

fn push_fold(qb: &mut QueryBuilder<Postgres>, col: &str) {
    qb.push("translate(lower(")
        .push(col)
        .push("), ")
        .push_bind(SQL_FOLD_FROM)
        .push(", ")
        .push_bind(SQL_FOLD_TO)
        .push(")");
}

fn order_id(qb: &mut QueryBuilder<Postgres>) {
    qb.push("id DESC");
}

/// `@HS` thành bản ghi có mã bắt đầu HS; `@Nguyễn` thành tên bắt đầu/chứa từ "Nguyễn"; rỗng thành bản ghi mới nhất. Mã khớp xếp trước.
pub async fn suggest(conn: &mut PgConnection, acc: &RefAccess, raw: &str, limit: i64) -> R<Vec<RefView>> {
    let t = trim_js(raw);
    let q: String = t.strip_prefix('@').unwrap_or(t).chars().take(60).collect();
    let n = limit.clamp(1, SUGGEST_MAX);
    let code_like = CODE_LIKE.is_match(&q);
    let by_code = if code_like {
        search_code(conn, acc, &q.to_uppercase(), n).await?
    } else {
        Vec::new()
    };
    let min = if code_like { 2 } else { 1 };
    let by_name = if q.encode_utf16().count() >= min || q.is_empty() {
        search_name(conn, acc, &q, n).await?
    } else {
        Vec::new()
    };
    let mut seen = std::collections::HashSet::new();
    let mut out = Vec::new();
    for v in by_code.into_iter().chain(by_name) {
        if seen.insert(v.reference()) {
            out.push(v);
        }
    }
    out.truncate(usize::try_from(n).unwrap_or(0));
    Ok(out)
}

async fn search_code(conn: &mut PgConnection, acc: &RefAccess, q: &str, n: i64) -> R<Vec<RefView>> {
    let like = format!("{}%", escape_like(q));
    let head: String = q.chars().take(2).collect();
    let core: Vec<RefType> = CORE
        .iter()
        .filter(|(_, p)| p.starts_with(&head) || q.starts_with(p))
        .map(|(t, _)| *t)
        .collect();
    let mut all = views(
        find_records(
            conn,
            acc,
            &|qb| {
                qb.push("code LIKE ").push_bind(like.clone()).push(" ESCAPE '\\'");
            },
            n,
            &|qb| {
                qb.push("code_seq ASC, id ASC");
            },
        )
        .await?,
    );
    for t in core {
        let pred = Pred::CodePrefix(q);
        all.extend(match t {
            RefType::Contact => find_contacts(conn, acc, pred, n).await?,
            RefType::Deal => find_deals(conn, acc, pred, n).await?,
            _ => find_tasks(conn, acc, pred, n).await?,
        });
    }
    all.sort_by(|a, b| {
        compare(
            a.code.as_deref().unwrap_or(""),
            b.code.as_deref().unwrap_or(""),
            Collation::EnNumeric,
        )
    });
    Ok(all)
}

async fn name_ids(conn: &mut PgConnection, table: &'static str, col: &'static str, lower: &str) -> R<Vec<i32>> {
    let mut qb = QueryBuilder::<Postgres>::new("SELECT id FROM ");
    qb.push(table).push(" WHERE ");
    push_fold(&mut qb, col);
    qb.push(" LIKE ")
        .push_bind(format!("%{lower}%"))
        .push(" ESCAPE '\\' ORDER BY id DESC LIMIT ")
        .push_bind(NAME_CANDIDATES);
    qb.build_query_scalar::<i32>().fetch_all(&mut *conn).await.map_err(db)
}

async fn search_name(conn: &mut PgConnection, acc: &RefAccess, q: &str, n: i64) -> R<Vec<RefView>> {
    if q.is_empty() {
        return Ok(views(
            find_records(
                conn,
                acc,
                &|qb| {
                    qb.push("TRUE");
                },
                n,
                &|qb| {
                    qb.push("updated_at DESC");
                },
            )
            .await?,
        ));
    }
    let lower = escape_like(&fold_vi(q));
    let (c_ids, d_ids, t_ids) = (
        if q.encode_utf16().count() >= 2 {
            name_ids(conn, "contacts", "full_name", &lower).await?
        } else {
            Vec::new()
        },
        name_ids(conn, "deals", "title", &lower).await?,
        name_ids(conn, "kanban_cards", "title", &lower).await?,
    );
    let starts = format!("{lower}%");
    let mut out = views(
        find_records(
            conn,
            acc,
            &|qb| {
                qb.push("(");
                push_fold(qb, "title");
                qb.push(" LIKE ").push_bind(starts.clone()).push(" ESCAPE '\\' OR ");
                push_fold(qb, "title");
                qb.push(" LIKE ").push_bind(format!("% {lower}%")).push(" ESCAPE '\\')");
            },
            n,
            &|qb| {
                qb.push("(");
                push_fold(qb, "title");
                qb.push(" LIKE ")
                    .push_bind(starts.clone())
                    .push(" ESCAPE '\\') DESC, id DESC");
            },
        )
        .await?,
    );
    out.extend(find_contacts(conn, acc, Pred::Ids(&c_ids), n).await?);
    out.extend(find_deals(conn, acc, Pred::Ids(&d_ids), n).await?);
    out.extend(find_tasks(conn, acc, Pred::Ids(&t_ids), n).await?);
    Ok(out)
}

/// Mã thành bản ghi người xem thấy (mã CŨ qua alias tiền tố vẫn ra). Khoá map = mã chuẩn.
pub async fn resolve_codes(conn: &mut PgConnection, acc: &RefAccess, codes: &[String]) -> R<HashMap<String, RefView>> {
    let mut parsed: Vec<ParsedCode> = Vec::new();
    for c in codes.iter().filter_map(|c| parse_code(c)) {
        if !parsed.iter().any(|p| p.code == c.code) {
            parsed.push(c);
        }
    }
    parsed.truncate(100);
    let mut out = HashMap::new();
    if parsed.is_empty() {
        return Ok(out);
    }
    let core = |p: &str| -> Vec<String> {
        parsed
            .iter()
            .filter(|c| c.prefix == p)
            .map(|c| c.code.clone())
            .collect()
    };
    let mut want: HashMap<(i32, i32), String> = HashMap::new();
    let mut pairs: Vec<(i32, i32)> = Vec::new();
    for c in &parsed {
        for o in acc.objects.values() {
            let hit =
                o.code_prefix.as_deref() == Some(c.prefix.as_str()) || o.code_prefix_aliases.0.contains(&c.prefix);
            if hit {
                pairs.push((o.id, c.seq));
                want.insert((o.id, c.seq), c.code.clone());
            }
        }
    }
    if !pairs.is_empty() {
        let hits = find_records(
            conn,
            acc,
            &|qb| {
                for (i, (o, s)) in pairs.iter().enumerate() {
                    if i > 0 {
                        qb.push(" OR ");
                    }
                    qb.push("(object_id = ")
                        .push_bind(*o)
                        .push(" AND code_seq = ")
                        .push_bind(*s)
                        .push(")");
                }
            },
            i64::try_from(pairs.len()).unwrap_or(i64::MAX),
            &order_id,
        )
        .await?;
        for h in hits {
            let key = h.code_seq.and_then(|s| want.get(&(h.object_id, s)).cloned());
            out.insert(key.or_else(|| h.view.code.clone()).unwrap_or_default(), h.view);
        }
    }
    for (ty, prefix) in CORE {
        let list = core(prefix);
        if list.is_empty() {
            continue;
        }
        let pred = Pred::CodesIn(&list);
        let found = match ty {
            RefType::Contact => find_contacts(conn, acc, pred, 100).await?,
            RefType::Deal => find_deals(conn, acc, pred, 100).await?,
            _ => find_tasks(conn, acc, pred, 100).await?,
        };
        for v in found {
            if let Some(c) = v.code.clone() {
                out.insert(c, v);
            }
        }
    }
    Ok(out)
}

/// `loại:id` thành bản ghi người xem thấy (thiếu trong map = đã xoá hoặc ngoài phạm vi).
pub async fn resolve_refs(conn: &mut PgConnection, acc: &RefAccess, refs: &[Ref]) -> R<HashMap<String, RefView>> {
    let mut out = HashMap::new();
    if refs.is_empty() {
        return Ok(out);
    }
    let ids = |t: RefType| -> Vec<i32> {
        let mut v: Vec<i32> = Vec::new();
        for r in refs.iter().filter(|r| r.ty == t) {
            if !v.contains(&r.id) {
                v.push(r.id);
            }
        }
        v.truncate(500);
        v
    };
    let (rec, con, deal, task) = (
        ids(RefType::Record),
        ids(RefType::Contact),
        ids(RefType::Deal),
        ids(RefType::Task),
    );
    let mut all: Vec<RefView> = Vec::new();
    if !rec.is_empty() {
        all.extend(views(
            find_records(
                conn,
                acc,
                &|qb| {
                    qb.push("id = ANY(").push_bind(rec.clone()).push(")");
                },
                500,
                &order_id,
            )
            .await?,
        ));
    }
    if !con.is_empty() {
        all.extend(find_contacts(conn, acc, Pred::Ids(&con), 500).await?);
    }
    if !deal.is_empty() {
        all.extend(find_deals(conn, acc, Pred::Ids(&deal), 500).await?);
    }
    if !task.is_empty() {
        all.extend(find_tasks(conn, acc, Pred::Ids(&task), 500).await?);
    }
    for v in all {
        out.insert(v.reference(), v);
    }
    Ok(out)
}

/// Chuỗi người dùng/AI gửi (mã `HS001` hoặc `record:12`) thành tham chiếu người GHI được thấy; mục không ra ⇒ `missing`.
pub async fn resolve_tokens(
    conn: &mut PgConnection,
    acc: &RefAccess,
    tokens: &[String],
) -> R<(Vec<RefView>, Vec<String>)> {
    let as_refs: Vec<Option<Ref>> = tokens.iter().map(|t| parse_ref(t)).collect();
    let refs: Vec<Ref> = as_refs.iter().flatten().copied().collect();
    let code_tokens: Vec<String> = tokens
        .iter()
        .zip(&as_refs)
        .filter(|(_, r)| r.is_none())
        .map(|(t, _)| t.clone())
        .collect();
    let by_ref = resolve_refs(conn, acc, &refs).await?;
    let by_code = resolve_codes(conn, acc, &code_tokens).await?;
    let mut found: Vec<RefView> = Vec::new();
    let mut missing = Vec::new();
    for (t, r) in tokens.iter().zip(&as_refs) {
        let v = match r {
            Some(r) => by_ref.get(&r.key()),
            None => by_code.get(&parse_code(t).map(|c| c.code).unwrap_or_default()),
        };
        match v {
            Some(v) => {
                if !found.iter().any(|x| x.reference() == v.reference()) {
                    found.push(v.clone());
                }
            }
            None => missing.push(t.clone()),
        }
    }
    Ok((found, missing))
}

// ---------------------------------------------------------------------------------------------------------------
// Liên kết có cấu trúc (`record_links`)

/// Trường sinh liên kết: ô chữ dài (thẻ @ trong văn bản) + trường kiểu "Liên kết".
pub fn linking_fields(def: &ObjectDef) -> Vec<&FieldDef> {
    def.fields
        .iter()
        .filter(|f| f.kind == "long_text" || f.kind == "link")
        .collect()
}

/// Nhãn cho trường văn bản của màn LÕI (nguồn không phải bản ghi tuỳ biến).
pub fn core_field_label(field: &str) -> String {
    if field == "description" {
        "Mô tả".into()
    } else if field == "reminder_notes" {
        "Ghi chú nhắc".into()
    } else if field.starts_with("note:") {
        "Ghi chú".into()
    } else if field.starts_with("comment:") {
        "Bình luận".into()
    } else {
        field.into()
    }
}

/// Đích của từng trường liên kết trong `data` (chỉ các trường `keys`). Văn bản: mã @ người ghi thấy được; Liên kết: giá trị đã kiểm.
pub async fn targets_for(
    conn: &mut PgConnection,
    acc: &RefAccess,
    def: &ObjectDef,
    data: &Map<String, Value>,
    keys: Option<&[String]>,
) -> R<Vec<(String, Vec<Ref>)>> {
    let fields: Vec<&FieldDef> = linking_fields(def)
        .into_iter()
        .filter(|f| keys.is_none_or(|k| k.contains(&f.key)))
        .collect();
    let mut codes: Vec<String> = Vec::new();
    for f in &fields {
        if f.kind == "long_text"
            && let Some(s) = data.get(&f.key).and_then(Value::as_str)
        {
            for c in extract_mention_codes(s, 50) {
                if !codes.contains(&c) {
                    codes.push(c);
                }
            }
        }
    }
    let by_code = if codes.is_empty() {
        HashMap::new()
    } else {
        resolve_codes(conn, acc, &codes).await?
    };
    let mut out = Vec::new();
    for f in fields {
        let v = data.get(&f.key);
        let list: Vec<Ref> = if f.kind == "link" {
            v.and_then(Value::as_array)
                .map(|a| a.iter().filter_map(Value::as_str).filter_map(parse_ref).collect())
                .unwrap_or_default()
        } else {
            match v.and_then(Value::as_str) {
                Some(s) => extract_mention_codes(s, 50)
                    .iter()
                    .filter_map(|c| by_code.get(c))
                    .map(|x| Ref { ty: x.ty, id: x.id })
                    .collect(),
                None => Vec::new(),
            }
        };
        out.push((f.key.clone(), list));
    }
    Ok(out)
}

/// Ghi lại cạnh của MỘT nguồn theo từng trường (xoá cạnh cũ của trường đó, thêm cạnh hiện tại). Gọi trong transaction ghi bản ghi.
pub async fn sync_links(
    conn: &mut PgConnection,
    source: Ref,
    targets: &[(String, Vec<Ref>)],
    user_id: Option<i32>,
) -> R<()> {
    for (field, list) in targets {
        sqlx::query("DELETE FROM record_links WHERE source_type = $1 AND source_id = $2 AND source_field = $3")
            .bind(source.ty.as_str())
            .bind(source.id)
            .bind(field)
            .execute(&mut *conn)
            .await
            .map_err(db)?;
        let mut uniq: Vec<Ref> = Vec::new();
        for t in list {
            if *t != source && !uniq.contains(t) {
                uniq.push(*t);
            }
        }
        if uniq.is_empty() {
            continue;
        }
        let types: Vec<String> = uniq.iter().map(|t| t.ty.as_str().to_owned()).collect();
        let ids: Vec<i32> = uniq.iter().map(|t| t.id).collect();
        sqlx::query(
            "INSERT INTO record_links (source_type, source_id, source_field, target_type, target_id, created_by) \
             SELECT $1, $2, $3, x.t, x.i, $6 FROM unnest($4::text[], $5::int4[]) AS x(t, i) ON CONFLICT DO NOTHING",
        )
        .bind(source.ty.as_str())
        .bind(source.id)
        .bind(field)
        .bind(types)
        .bind(ids)
        .bind(user_id)
        .execute(&mut *conn)
        .await
        .map_err(db)?;
    }
    Ok(())
}

/// Thẻ @ trong ô chữ của màn LÕI (mô tả công việc, ghi chú khách): ghi lại cạnh `source` (trường `field`) tới các bản ghi được
/// nhắc mà NGƯỜI GHI thấy được; văn bản rỗng xoá cạnh cũ. Không làm hỏng thao tác lưu chính: lỗi chỉ ghi log.
pub async fn sync_mentions(ctx: &Ctx, actor: &Actor, source: Ref, field: &str, text: Option<&str>) {
    let run = async {
        let owners = Owners::load(ctx, actor).await?;
        let mut conn = ctx.conn(actor.company).await?;
        let acc = RefAccess::build(&mut conn, actor, owners).await?;
        let codes = text.map(|t| extract_mention_codes(t, 50)).unwrap_or_default();
        let found = if codes.is_empty() {
            HashMap::new()
        } else {
            resolve_codes(&mut conn, &acc, &codes).await?
        };
        let targets: Vec<Ref> = found.values().map(|v| Ref { ty: v.ty, id: v.id }).collect();
        sync_links(&mut conn, source, &[(field.to_owned(), targets)], Some(actor.user_id)).await
    };
    if let Err(e) = run.await {
        tracing::warn!("syncMentions {}/{field} lỗi: {e}", source.key());
    }
}

/// "Được nhắc tới ở": bản ghi đang gắn thẻ / liên kết tới `target`, CHỈ những nguồn người xem thấy được (+ đích phải thấy được, không thì 404).
pub async fn backlinks(conn: &mut PgConnection, acc: &RefAccess, target: Ref) -> R<Value> {
    if resolve_refs(conn, acc, &[target]).await?.is_empty() {
        return Err(not_found("Không tìm thấy bản ghi"));
    }
    let rows: Vec<(String, i32, String)> = sqlx::query_as(
        "SELECT source_type, source_id, source_field FROM record_links WHERE target_type = $1 AND target_id = $2 ORDER BY id DESC LIMIT 500",
    )
    .bind(target.ty.as_str())
    .bind(target.id)
    .fetch_all(&mut *conn)
    .await
    .map_err(db)?;
    let refs: Vec<Ref> = rows
        .iter()
        .filter_map(|(t, i, _)| {
            Some(Ref {
                ty: RefType::parse(t)?,
                id: *i,
            })
        })
        .collect();
    let sources = resolve_refs(conn, acc, &refs).await?;
    let record_ids: Vec<i32> = rows
        .iter()
        .filter(|(t, _, _)| t == "record")
        .map(|(_, i, _)| *i)
        .collect();
    let labels: HashMap<(i32, String), String> = if record_ids.is_empty() {
        HashMap::new()
    } else {
        let l: Vec<(i32, String, String)> = sqlx::query_as(
            "SELECT r.id, f.key, f.label FROM custom_records r JOIN custom_fields f ON f.object_id = r.object_id AND f.deleted_at IS NULL \
             WHERE r.id = ANY($1::int4[]) AND f.type IN ('long_text', 'link')",
        )
        .bind(record_ids)
        .fetch_all(&mut *conn)
        .await
        .map_err(db)?;
        l.into_iter().map(|(r, k, l)| ((r, k), l)).collect()
    };
    let mut order: Vec<String> = Vec::new();
    let mut groups: HashMap<String, (RefView, Vec<String>)> = HashMap::new();
    for (ty, id, field) in rows {
        let Some(src) = Ref::key_of(&ty, id).and_then(|k| sources.get(&k)) else {
            continue;
        };
        let r = src.reference();
        let label = if ty == "record" {
            labels.get(&(id, field.clone())).cloned().unwrap_or(field)
        } else {
            core_field_label(&field)
        };
        let entry = groups.entry(r.clone()).or_insert_with(|| {
            order.push(r.clone());
            (src.clone(), Vec::new())
        });
        if !entry.1.contains(&label) {
            entry.1.push(label);
        }
    }
    let list: Vec<Value> = order
        .iter()
        .take(BACKLINKS_MAX)
        .filter_map(|k| groups.get(k))
        .map(|(s, f)| json!({ "source": s.to_json(), "fields": f }))
        .collect();
    Ok(Value::Array(list))
}

impl Ref {
    fn key_of(ty: &str, id: i32) -> Option<String> {
        RefType::parse(ty).map(|t| Ref { ty: t, id }.key())
    }
}

// ---------------------------------------------------------------------------------------------------------------
// Xem nhanh

const MAX_PREVIEW_FIELDS: usize = 5;

fn vn_money(n: f64) -> String {
    format!("{} đ", trinity_kernel::number::format_vn_number(n))
}

/// Một giá trị đã trình bày thành chữ ngắn (xem nhanh khi rê chuột vào thẻ @). SĐT đã được presenter che theo quyền.
pub fn preview_text(f: &FieldDef, rec: &Value) -> Option<String> {
    let v = rec.get("data")?.get(&f.key)?;
    if v.is_null() || v.as_str() == Some("") {
        return None;
    }
    if let Some(rel) = rec.get("relations").and_then(|r| r.get(&f.key)) {
        let items: Vec<&Value> = rel.as_array().map_or_else(|| vec![rel], |a| a.iter().collect());
        return Some(
            items
                .iter()
                .map(|r| {
                    r.get("title")
                        .and_then(Value::as_str)
                        .unwrap_or("Không xem được")
                        .to_owned()
                })
                .collect::<Vec<_>>()
                .join(", "),
        );
    }
    let label_of = |x: &Value| -> String {
        f.options
            .get("choices")
            .and_then(Value::as_array)
            .and_then(|a| a.iter().find(|c| c.get("value") == Some(x)))
            .and_then(|c| c.get("label").and_then(Value::as_str))
            .map_or_else(|| plain(x), str::to_owned)
    };
    match (f.kind.as_str(), v) {
        ("select", _) => Some(label_of(v)),
        ("multi_select", Value::Array(a)) => Some(a.iter().map(label_of).collect::<Vec<_>>().join(", ")),
        ("boolean", _) => Some(if v == &Value::Bool(true) { "Có" } else { "Không" }.into()),
        ("date", Value::String(s)) => Some(s.split('-').rev().collect::<Vec<_>>().join("/")),
        ("datetime", Value::String(s)) => Some(vn_date_time(s)),
        ("currency", Value::Number(n)) => Some(vn_money(n.as_f64().unwrap_or(0.0))),
        _ => {
            let s = plain(v);
            Some(if s.encode_utf16().count() > 120 {
                format!("{}…", s.chars().take(117).collect::<String>())
            } else {
                s
            })
        }
    }
}

/// `String(v)` của JS cho giá trị JSON.
pub fn plain(v: &Value) -> String {
    match v {
        Value::Null => String::new(),
        Value::String(s) => s.clone(),
        Value::Number(n) => trinity_kernel::json::js_number(n.as_f64().unwrap_or(f64::NAN)),
        Value::Bool(b) => b.to_string(),
        Value::Array(a) => a.iter().map(plain).collect::<Vec<_>>().join(","),
        Value::Object(_) => "[object Object]".into(),
    }
}

fn vn_day(at: Option<trinity_db::types::Timestamp>) -> String {
    at.map_or_else(
        || "—".to_owned(),
        |t| vn_date(&(t.0 + chrono::Duration::hours(7)).format("%Y-%m-%d").to_string()),
    )
}

async fn preview_fields(
    actor: &Actor,
    conn: &mut PgConnection,
    acc: &RefAccess,
    env: &Env,
    v: &RefView,
) -> R<Vec<Value>> {
    let field = |l: &str, value: String| json!({ "label": l, "value": value });
    match v.ty {
        RefType::Record => {
            let Some(key) = &v.table_key else { return Ok(Vec::new()) };
            let def = load_visible_object(conn, actor, key, None).await?;
            let row = crate::records::load_row(conn, v.id).await?;
            let rec = present(conn, actor, &def, &[row], env, Some(acc)).await?.remove(0);
            Ok(def
                .fields
                .iter()
                .filter(|f| !f.is_title && f.show_in_list && f.kind != "long_text")
                .filter_map(|f| preview_text(f, &rec).map(|value| field(&f.label, value)))
                .take(MAX_PREVIEW_FIELDS)
                .collect())
        }
        RefType::Contact => {
            let r: Option<(Option<trinity_db::types::Timestamp>, Option<String>)> = sqlx::query_as(
                "SELECT c.created_at, u.full_name FROM contacts c LEFT JOIN users u ON u.id = c.assigned_to WHERE c.id = $1",
            )
            .bind(v.id)
            .fetch_optional(&mut *conn)
            .await
            .map_err(db)?;
            let (at, name) = r.unwrap_or((None, None));
            Ok(vec![
                field("Phụ trách", name.unwrap_or_else(|| "—".into())),
                field("Ngày tạo", vn_day(at)),
            ])
        }
        RefType::Deal => {
            let r: Option<(String, Option<i64>)> = sqlx::query_as("SELECT status, value FROM deals WHERE id = $1")
                .bind(v.id)
                .fetch_optional(&mut *conn)
                .await
                .map_err(db)?;
            let (status, value) = r.unwrap_or(("—".to_owned(), None));
            let value = value.map_or_else(|| "—".to_owned(), |n| vn_money(n as f64));
            Ok(vec![field("Trạng thái", status), field("Giá trị", value)])
        }
        RefType::Task => {
            let r: Option<(Option<trinity_db::types::Timestamp>, String, String)> = sqlx::query_as(
                "SELECT k.due_at, c.name, b.name FROM kanban_cards k JOIN kanban_columns c ON c.id = k.column_id \
                 JOIN kanban_boards b ON b.id = k.board_id WHERE k.id = $1",
            )
            .bind(v.id)
            .fetch_optional(&mut *conn)
            .await
            .map_err(db)?;
            let (due, col, board) = r.unwrap_or((None, "—".to_owned(), "—".to_owned()));
            Ok(vec![field("Bảng", board), field("Cột", col), field("Hạn", vn_day(due))])
        }
    }
}

/// Xem nhanh một bản ghi (rê chuột vào thẻ @): mã, tên, bảng + vài trường, chỉ khi người xem thấy được bản ghi. `env` lấy TRƯỚC khi giữ `conn`.
pub async fn preview(actor: &Actor, conn: &mut PgConnection, acc: &RefAccess, env: &Env, r: Ref) -> R<Value> {
    let view = resolve_refs(conn, acc, &[r])
        .await?
        .remove(&r.key())
        .ok_or_else(|| not_found("Không tìm thấy bản ghi"))?;
    let fields = preview_fields(actor, conn, acc, env, &view).await?;
    let mut j = view.to_json();
    j.as_object_mut()
        .ok_or_else(|| internal("RefView không phải object"))?
        .insert("fields".into(), Value::Array(fields));
    Ok(j)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_nhac_toi() {
        assert_eq!(
            extract_mention_codes("Gặp @hs1 và @KH012, @hs001 lại.", 50),
            ["HS001", "KH012"]
        );
        assert!(extract_mention_codes("mail a@hs001.vn x@@hs2 @hs3x @h1 @hs1234567890 Ahs@hs4", 50).is_empty());
        assert_eq!(extract_mention_codes("@AB1000 @ab9", 50), ["AB1000", "AB009"]);
        assert_eq!(extract_mention_codes("@ab1 @cd2 @ef3", 2), ["AB001", "CD002"]);
        assert_eq!(extract_mention_codes("@hs1\n@hs2", 50), ["HS001", "HS002"]);
        assert_eq!(extract_mention_codes("(@hs5)", 50), ["HS005"]);
    }

    #[test]
    fn ma_va_tham_chieu() {
        assert_eq!(parse_ref(" record:12 ").map(Ref::key).as_deref(), Some("record:12"));
        assert!(parse_ref("record:0").is_none());
        assert!(parse_ref("record:99999999999").is_none());
        assert!(parse_ref("x:1").is_none());
        let c = parse_code("hs1").unwrap();
        assert_eq!((c.prefix.as_str(), c.seq, c.code.as_str()), ("HS", 1, "HS001"));
        assert!(parse_code("hs0").is_none());
        assert_eq!(format_code("HS", 1000), "HS1000");
        assert!(CODE_LIKE.is_match("HS") && CODE_LIKE.is_match("hs12") && !CODE_LIKE.is_match("Nguyễn"));
    }

    #[test]
    fn xem_nhanh() {
        let f = FieldDef {
            id: 1,
            key: "g".into(),
            label: "Giá".into(),
            kind: "currency".into(),
            required: false,
            is_unique: false,
            is_title: false,
            show_in_list: true,
            sort_order: 0,
            options: json!({}),
            help_text: None,
        };
        let rec = json!({ "data": { "g": 1234567 }, "relations": {} });
        assert_eq!(preview_text(&f, &rec).as_deref(), Some("1.234.567 đ"));
    }
}
