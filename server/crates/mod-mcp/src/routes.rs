//! 3 route công khai `/api/v1/mcp` (`POST` JSON-RPC, `GET`/`DELETE` ⇒ 405) khớp `contracts/routes.json`, và router axum bọc
//! [`crate::endpoint::McpEndpoint`]. Xác thực nằm trong endpoint (token OAuth), nên cả ba là `Access::Public`; thân là bytes thô
//! (`raw_response`), không qua bộ kiểm DTO.

use std::sync::Arc;

use axum::body::to_bytes;
use axum::extract::{Request, State};
use axum::http::{HeaderName, HeaderValue, Method, StatusCode};
use axum::response::Response;
use trinity_http::edge::client_ip::{ClientIp, ClientIpResolver, resolve_client_ip};
use trinity_http::router::{Access, AccessDeps, ApiRouter, RouteSpec};

use crate::endpoint::{HttpIn, McpEndpoint};

const PATH: &str = "/api/v1/mcp";
const BODY_LIMIT: usize = 5 * 1024 * 1024;

pub fn specs() -> Vec<RouteSpec> {
    vec![
        RouteSpec::new(Method::POST, PATH, Access::Public).status_ok(200),
        RouteSpec::new(Method::GET, PATH, Access::Public),
        RouteSpec::new(Method::DELETE, PATH, Access::Public),
    ]
}

/// Trạng thái của router: endpoint + bộ xác định IP khách.
pub struct McpState {
    pub endpoint: McpEndpoint,
    pub ip: Arc<ClientIpResolver>,
}

fn header(req: &Request, name: &str) -> Option<String> {
    req.headers().get(name).and_then(|v| v.to_str().ok()).map(str::to_owned)
}

async fn mcp(State(s): State<Arc<McpState>>, req: Request) -> Response {
    let client: ClientIp = resolve_client_ip(&s.ip, &req);
    let (method, origin, authorization, accept, content_type, protocol_version) = (
        req.method().as_str().to_owned(),
        header(&req, "origin"),
        header(&req, "authorization"),
        header(&req, "accept"),
        header(&req, "content-type"),
        header(&req, "mcp-protocol-version"),
    );
    let body = match to_bytes(req.into_body(), BODY_LIMIT).await {
        Ok(b) => b.to_vec(),
        Err(_) => {
            let mut r = Response::new(axum::body::Body::from(
                "{\"statusCode\":413,\"message\":\"request entity too large\",\"error\":\"Payload Too Large\"}",
            ));
            *r.status_mut() = StatusCode::PAYLOAD_TOO_LARGE;
            return r;
        }
    };
    let out = s
        .endpoint
        .handle(HttpIn {
            method,
            origin,
            authorization,
            accept,
            content_type,
            protocol_version,
            body,
            client,
        })
        .await;
    let mut r = Response::new(axum::body::Body::from(out.body));
    *r.status_mut() = StatusCode::from_u16(out.status).unwrap_or(StatusCode::INTERNAL_SERVER_ERROR);
    for (k, v) in out.headers {
        if let Ok(v) = HeaderValue::from_str(&v) {
            r.headers_mut().insert(HeaderName::from_static(k), v);
        }
    }
    r
}

/// Router của module: mọi route đi qua `ApiRouter` (khai quyền bắt buộc). Người gọi gắn state `Arc<McpState>`.
pub fn api_router(deps: Arc<AccessDeps>) -> ApiRouter<Arc<McpState>> {
    let mut r = ApiRouter::new(deps);
    for spec in specs() {
        r = r.route(spec, mcp);
    }
    r
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn khop_hop_dong_routes_json() {
        let table = specs();
        assert_eq!(table.len(), 3);
        let rep = trinity_http::router::check::check_embedded(&table, false);
        assert!(rep.ok(), "{:#?}", rep.problems);
    }
}
