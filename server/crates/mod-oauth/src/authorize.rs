//! Kiểm yêu cầu uỷ quyền (`authorize-request.ts`). Thứ tự: client → `redirect_uri` (sai ⇒ KHÔNG redirect, chống open
//! redirect) → phần còn lại (lỗi ⇒ redirect về client kèm `state` và `iss`).

use serde_json::{Map, Value, json};
use url::Url;

use crate::clients::OauthClient;
use crate::config::{
    ADVERTISED_SCOPES, DEFAULT_SCOPES, OAUTH_SCOPES, is_canonical_resource, issuer_url, mcp_resource_url,
};
use crate::crypto::{is_code_challenge, sha256_hex};
use crate::error::{OAuthError, R};
use crate::redirect::redirect_uri_matches;
use crate::util::{js_len, split_js_space};

const MAX_STATE: usize = 512;

/// Tham số yêu cầu uỷ quyền như client gửi (chưa tin).
pub type AuthorizeInput = Map<String, Value>;

#[derive(Debug, Clone)]
pub struct ValidAuthorize {
    pub client: OauthClient,
    pub redirect_uri: String,
    pub scopes: Vec<String>,
    pub state: Option<String>,
    pub resource: String,
    pub code_challenge: String,
}

/// Chuỗi không rỗng (`optStr`).
pub fn opt_str<'a>(input: &'a AuthorizeInput, key: &str) -> Option<&'a str> {
    input.get(key).and_then(Value::as_str).filter(|s| !s.is_empty())
}

/// URL trả về cho client kèm `iss` (RFC 9207, chống mix-up) và `state`; thay (không nối) tham số cùng tên như `searchParams.set`.
pub fn build_client_redirect(redirect_uri: &str, base: &str, params: &[(&str, Option<&str>)]) -> R<String> {
    let mut u = Url::parse(redirect_uri).map_err(|e| OAuthError::internal("redirect_uri", e))?;
    let mut pairs: Vec<(String, String)> = u.query_pairs().map(|(k, v)| (k.into_owned(), v.into_owned())).collect();
    let mut set = |k: &str, v: &str| {
        match pairs.iter().position(|(pk, _)| pk == k) {
            Some(i) => {
                pairs[i].1 = v.to_owned();
                let mut seen = false;
                pairs.retain(|(pk, _)| {
                    if pk == k {
                        let keep = !seen;
                        seen = true;
                        keep
                    } else {
                        true
                    }
                });
            }
            None => pairs.push((k.to_owned(), v.to_owned())),
        };
    };
    for (k, v) in params {
        if let Some(v) = v {
            set(k, v);
        }
    }
    set("iss", &issuer_url(base));
    u.query_pairs_mut().clear().extend_pairs(pairs);
    Ok(u.to_string())
}

/// Kiểm `redirect_uri` với client ĐÃ resolve.
pub fn assert_redirect_uri(client: &OauthClient, input: &AuthorizeInput) -> R<String> {
    match opt_str(input, "redirect_uri") {
        Some(uri) if client.redirect_uris.iter().any(|r| redirect_uri_matches(r, uri)) => Ok(uri.to_owned()),
        _ => Err(OAuthError::new(
            "invalid_request",
            "redirect_uri không khớp với địa chỉ client đã đăng ký",
        )),
    }
}

fn parse_scopes(raw: Option<&Value>) -> Result<Vec<String>, ()> {
    let asked = raw.and_then(Value::as_str).map(split_js_space).unwrap_or_default();
    if asked.iter().any(|s| !ADVERTISED_SCOPES.contains(s)) {
        return Err(());
    }
    let mut real: Vec<String> = Vec::new();
    for s in asked {
        if OAUTH_SCOPES.contains(&s) && !real.iter().any(|r| r == s) {
            real.push(s.to_owned());
        }
    }
    if real.is_empty() {
        real = DEFAULT_SCOPES.iter().map(|s| (*s).to_owned()).collect();
    }
    Ok(real)
}

/// Phần CÒN LẠI sau khi client + `redirect_uri` hợp lệ; mọi lỗi là `redirectable`. PKCE chỉ S256 (`plain`/thiếu ⇒ từ chối,
/// chống hạ cấp); `resource` phải là URL MCP của CHÍNH ta.
pub fn validate_authorize_rest(
    client: OauthClient,
    redirect_uri: String,
    input: &AuthorizeInput,
    base: &str,
) -> R<ValidAuthorize> {
    let state = opt_str(input, "state");
    if state.is_some_and(|s| js_len(s) > MAX_STATE) {
        return Err(OAuthError::redirectable("invalid_request", "state quá dài"));
    }
    if input.get("response_type").and_then(Value::as_str) != Some("code") {
        return Err(OAuthError::redirectable(
            "unsupported_response_type",
            "Chỉ hỗ trợ response_type=code",
        ));
    }
    let challenge = opt_str(input, "code_challenge").filter(|c| is_code_challenge(c));
    let Some(challenge) = challenge else {
        return Err(OAuthError::redirectable(
            "invalid_request",
            "Thiếu hoặc sai code_challenge (PKCE bắt buộc)",
        ));
    };
    if input.get("code_challenge_method").and_then(Value::as_str) != Some("S256") {
        return Err(OAuthError::redirectable(
            "invalid_request",
            "code_challenge_method phải là S256",
        ));
    }
    let scopes = parse_scopes(input.get("scope"))
        .map_err(|()| OAuthError::redirectable("invalid_scope", "scope không được hỗ trợ"))?;
    if let Some(r) = opt_str(input, "resource")
        && !is_canonical_resource(r, base)
    {
        return Err(OAuthError::redirectable(
            "invalid_target",
            "resource không phải máy chủ MCP của hệ thống này",
        ));
    }
    Ok(ValidAuthorize {
        client,
        redirect_uri,
        scopes,
        state: state.map(str::to_owned),
        resource: mcp_resource_url(base),
        code_challenge: challenge.to_owned(),
    })
}

/// Băm tham số đã hiển thị: token consent ràng buộc quyết định với đúng yêu cầu này (cùng công thức với bản Node).
pub fn authorize_fingerprint(v: &ValidAuthorize) -> String {
    let mut scopes = v.scopes.clone();
    scopes.sort();
    let arr = json!([
        v.client.client_id,
        v.redirect_uri,
        scopes,
        v.state.clone().unwrap_or_default(),
        v.resource,
        v.code_challenge
    ]);
    sha256_hex(&trinity_kernel::json::js_json(&arr))
}
