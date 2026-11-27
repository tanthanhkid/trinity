//! Metadata Authorization Server (RFC 8414) và Protected Resource (RFC 9728) (`oauth-metadata.ts`).

use serde_json::{Value, json};

use crate::config::{ADVERTISED_SCOPES, OAUTH_SCOPES, authorization_endpoint, issuer_url, mcp_resource_url};

pub fn authorization_server_metadata(base: &str) -> Value {
    let issuer = issuer_url(base);
    json!({
        "issuer": issuer,
        "authorization_endpoint": authorization_endpoint(base),
        "token_endpoint": format!("{issuer}/token"),
        "registration_endpoint": format!("{issuer}/register"),
        "revocation_endpoint": format!("{issuer}/revoke"),
        "scopes_supported": ADVERTISED_SCOPES,
        "response_types_supported": ["code"],
        "response_modes_supported": ["query"],
        "grant_types_supported": ["authorization_code", "refresh_token"],
        // Chỉ S256 (OAuth 2.1). Client phải thấy trường này mới chịu chạy.
        "code_challenge_methods_supported": ["S256"],
        // Claude chỉ dùng CIMD khi cả `client_id_metadata_document_supported` VÀ `none` đều có ở đây.
        "token_endpoint_auth_methods_supported": ["none", "client_secret_post"],
        "revocation_endpoint_auth_methods_supported": ["none", "client_secret_post"],
        "client_id_metadata_document_supported": true,
        // RFC 9207: `iss` luôn có trong phản hồi uỷ quyền.
        "authorization_response_iss_parameter_supported": true,
        "service_documentation": format!("{base}/settings"),
    })
}

pub fn protected_resource_metadata(base: &str) -> Value {
    json!({
        "resource": mcp_resource_url(base),
        "authorization_servers": [issuer_url(base)],
        "scopes_supported": OAUTH_SCOPES,
        "bearer_methods_supported": ["header"],
        "resource_name": "Trinity CRM (MCP)",
        "resource_documentation": format!("{base}/settings"),
    })
}
