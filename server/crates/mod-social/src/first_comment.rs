//! Bình luận đầu tiên dưới bài Fanpage (`facebook-first-comment.ts`). Đăng BẰNG TOKEN CỦA KẾT NỐI "Fanpage Facebook" (bảng
//! `facebook_pages`, đã có quyền bình luận): kết nối Đăng đa kênh không xin quyền này nên không phải thêm quyền mới. Lời gọi đi
//! qua [`mod_facebook::graph::GraphClient`] như mọi lời gọi Graph khác.

use mod_facebook::graph::utf16_prefix;
use mod_facebook::pages::Ctx;
use serde_json::{Map, Value};
use trinity_integrations::webhooks::secret::{decrypt_secret, load_secret_key};

use crate::posts::acquire;
use crate::utm::js_trim;

/// Facebook giới hạn bình luận 8.000 ký tự.
pub const FIRST_COMMENT_MAX: usize = 8000;

/// `firstCommentOf`: chữ đã cắt khoảng trắng; rỗng hoặc không phải chữ ⇒ `None`.
pub fn first_comment_of(options: &Map<String, Value>) -> Option<String> {
    match options.get("first_comment") {
        Some(Value::String(s)) if !js_trim(s).is_empty() => Some(js_trim(s).to_owned()),
        _ => None,
    }
}

/// Kết quả đăng bình luận đầu.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum FirstComment {
    Posted,
    /// Page chưa kết nối ở mục Fanpage Facebook (hoặc mất token) ⇒ bỏ qua.
    NoPage,
}

/// Id bài là MỘT đoạn đường dẫn (vd `123_456`): `/` hay ký tự lạ không được thành đoạn mới của URL Graph.
fn valid_object_id(id: &str) -> bool {
    !id.is_empty()
        && id
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || matches!(c, '_' | '.' | '-'))
}

/// Đăng bình luận đầu dưới `object_id` (bài vừa lên) của Page `page_id`. Lỗi ⇒ câu để ghi vào `last_error`; KHÔNG log token.
/// Mỗi bước DB một kết nối, nhả trước khi gọi Graph.
pub async fn post_first_comment(
    c: &Ctx<'_>,
    page_id: &str,
    object_id: &str,
    message: &str,
) -> Result<FirstComment, String> {
    let token_enc: Option<String> = {
        let mut conn = acquire(c.db, c.company).await.map_err(|e| e.to_string())?;
        sqlx::query_scalar(
            "SELECT token_enc FROM facebook_pages WHERE page_id = $1 AND is_active = true ORDER BY id LIMIT 1",
        )
        .bind(page_id)
        .fetch_optional(&mut *conn)
        .await
        .map_err(|e| e.to_string())?
    };
    let Some(token_enc) = token_enc.filter(|t| !t.is_empty()) else {
        return Ok(FirstComment::NoPage);
    };
    let env = c.env;
    let key = load_secret_key(&|k: &str| env(k)).map_err(|e| e.0)?;
    let token = decrypt_secret(&token_enc, &key).map_err(|e| e.0)?;
    if !valid_object_id(object_id) {
        return Err("Id bài Facebook không hợp lệ".to_owned());
    }
    let text = utf16_prefix(message, FIRST_COMMENT_MAX);
    match c.graph.reply_to_comment(&token, object_id, &text).await {
        Ok(_) => Ok(FirstComment::Posted),
        Err(e) => Err(format!(
            "Facebook từ chối bình luận đầu tiên: {}",
            utf16_prefix(&e.message, 200)
        )),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn opts(v: Value) -> Map<String, Value> {
        v.as_object().cloned().unwrap_or_default()
    }

    #[test]
    fn lay_binh_luan_dau() {
        let a = first_comment_of(&opts(json!({"first_comment": "  Chào  "})));
        assert_eq!(a.as_deref(), Some("Chào"));
        assert_eq!(first_comment_of(&opts(json!({"first_comment": "   "}))), None);
        assert_eq!(first_comment_of(&opts(json!({"first_comment": 5}))), None);
        assert_eq!(first_comment_of(&opts(json!({}))), None);
    }

    #[test]
    fn id_bai_hop_le() {
        assert!(valid_object_id("123_456"));
        assert!(valid_object_id("a.b-c"));
        assert!(!valid_object_id(""));
        assert!(!valid_object_id("1/2"));
        assert!(!valid_object_id("1?x=2"));
    }
}
