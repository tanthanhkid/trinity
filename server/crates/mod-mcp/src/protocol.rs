//! Vận chuyển JSON-RPC của MCP ở chế độ KHÔNG PHIÊN, TRẢ JSON (`StreamableHTTPServerTransport` với
//! `sessionIdGenerator: undefined`, `enableJsonResponse: true`) và 5 phương thức của `McpServer`: `initialize`,
//! `notifications/initialized`, `ping`, `tools/list`, `tools/call`. Không dùng SDK `rmcp` (docs/rust/PLAN.md mục 4.2): tự dựng để
//! trả đúng từng byte danh sách tool đóng băng.
//!
//! Thân phản hồi dựng thành chuỗi theo ĐÚNG thứ tự khoá của SDK (`result`, `jsonrpc`, `id` cho thành công; `jsonrpc`, `id`, `error`
//! cho lỗi phương thức; `jsonrpc`, `error`, `id` cho lỗi vận chuyển). Bảng ca `transport/*.json` ghi lại phản hồi thật của Node.
//!
//! Chưa có ca đóng băng cho: JSON-RPC hỏng cấu trúc, `params` sai kiểu, đối số sai schema, `structuredContent` sai
//! `outputSchema`: câu lỗi ở các trường hợp này là bản gần đúng của SDK/zod (cùng mã, cùng khung), không phải từng chữ.

use std::future::Future;
use std::pin::Pin;

use serde_json::{Map, Value};

use crate::frozen::{Frozen, INSTRUCTIONS, SERVER_NAME, SERVER_VERSION, strip_unknown};

pub const SUPPORTED_VERSIONS: [&str; 5] = ["2025-11-25", "2025-06-18", "2025-03-26", "2024-11-05", "2024-10-07"];
pub const LATEST_VERSION: &str = "2025-11-25";

pub type BoxFuture<'a, T> = Pin<Box<dyn Future<Output = T> + Send + 'a>>;

/// Kết quả một lời gọi tool, đã qua giới hạn/quyền/audit của [`crate::exec`].
#[derive(Debug, Clone, PartialEq)]
pub struct CallResult {
    pub text: String,
    pub structured: Option<Value>,
    pub is_error: bool,
}

impl CallResult {
    pub fn error(text: impl Into<String>) -> Self {
        Self {
            text: text.into(),
            structured: None,
            is_error: true,
        }
    }
}

/// Nơi thực thi tool (đối số đã kiểm schema và bỏ khoá lạ).
pub trait ToolHost: Send + Sync {
    fn call<'a>(&'a self, name: &'a str, args: Value) -> BoxFuture<'a, CallResult>;
}

/// Phần của request HTTP mà vận chuyển cần.
#[derive(Debug, Clone, Copy)]
pub struct Req<'a> {
    pub accept: Option<&'a str>,
    pub content_type: Option<&'a str>,
    pub protocol_version: Option<&'a str>,
    pub body: &'a [u8],
}

/// Phản hồi: `body = None` ⇒ 202 không thân (thông báo từ client). Có thân ⇒ `Content-Type: application/json`.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Reply {
    pub status: u16,
    pub body: Option<String>,
}

fn js(s: &str) -> String {
    serde_json::to_string(s).unwrap_or_else(|_| "\"\"".to_owned())
}

/// Lỗi vận chuyển: `{"jsonrpc":"2.0","error":{"code":-32000,"message":…},"id":null}`.
pub fn transport_error(status: u16, code: i32, message: &str) -> Reply {
    Reply {
        status,
        body: Some(format!(
            "{{\"jsonrpc\":\"2.0\",\"error\":{{\"code\":{code},\"message\":{}}},\"id\":null}}",
            js(message)
        )),
    }
}

fn id_json(id: &Value) -> String {
    serde_json::to_string(id).unwrap_or_else(|_| "null".to_owned())
}

fn ok(id: &Value, result: &str) -> Reply {
    Reply {
        status: 200,
        body: Some(format!(
            "{{\"result\":{result},\"jsonrpc\":\"2.0\",\"id\":{}}}",
            id_json(id)
        )),
    }
}

fn rpc_error(id: &Value, code: i32, message: &str) -> Reply {
    Reply {
        status: 200,
        body: Some(format!(
            "{{\"jsonrpc\":\"2.0\",\"id\":{},\"error\":{{\"code\":{code},\"message\":{}}}}}",
            id_json(id),
            js(message)
        )),
    }
}

fn tool_result(id: &Value, r: &CallResult) -> Reply {
    let text = js(&r.text);
    let result = match (&r.structured, r.is_error) {
        (Some(s), false) => format!(
            "{{\"content\":[{{\"type\":\"text\",\"text\":{text}}}],\"structuredContent\":{}}}",
            serde_json::to_string(s).unwrap_or_else(|_| "null".to_owned())
        ),
        (_, true) => format!("{{\"content\":[{{\"type\":\"text\",\"text\":{text}}}],\"isError\":true}}"),
        (None, false) => format!("{{\"content\":[{{\"type\":\"text\",\"text\":{text}}}]}}"),
    };
    ok(id, &result)
}

/// Lỗi của lời gọi tool trả như kết quả `isError` (không phải lỗi JSON-RPC), như SDK.
fn tool_failure(id: &Value, code: i32, message: &str) -> Reply {
    tool_result(id, &CallResult::error(format!("MCP error {code}: {message}")))
}

/// `Accept` phải có CẢ `application/json` và `text/event-stream` (so chuỗi con như SDK).
fn accept_ok(h: Option<&str>) -> bool {
    h.is_some_and(|a| a.contains("application/json") && a.contains("text/event-stream"))
}

fn is_initialize(m: &Map<String, Value>) -> bool {
    m.get("method").and_then(Value::as_str) == Some("initialize")
}

fn initialize(frozen_id: &Value, params: Option<&Value>) -> Reply {
    let requested = params.and_then(|p| p.get("protocolVersion")).and_then(Value::as_str);
    let Some(requested) = requested else {
        return rpc_error(frozen_id, -32602, "Invalid request parameters");
    };
    let version = if SUPPORTED_VERSIONS.contains(&requested) {
        requested
    } else {
        LATEST_VERSION
    };
    ok(
        frozen_id,
        &format!(
            "{{\"protocolVersion\":{},\"capabilities\":{{\"tools\":{{\"listChanged\":true}}}},\"serverInfo\":{{\"name\":{},\"version\":{}}},\"instructions\":{}}}",
            js(version),
            js(SERVER_NAME),
            js(SERVER_VERSION),
            js(INSTRUCTIONS)
        ),
    )
}

/// `tools/call`: tool lạ, đối số sai schema, kết quả sai `outputSchema` đều trả `isError` như SDK.
async fn tools_call(frozen: &Frozen, host: &dyn ToolHost, id: &Value, params: Option<&Value>) -> Reply {
    let Some(name) = params.and_then(|p| p.get("name")).and_then(Value::as_str) else {
        return rpc_error(id, -32602, "Invalid request parameters");
    };
    let args = match params.and_then(|p| p.get("arguments")) {
        None | Some(Value::Null) => Value::Object(Map::new()),
        Some(v) => v.clone(),
    };
    let Some(tool) = frozen.tool(name) else {
        return tool_failure(id, -32602, &format!("Tool {name} not found"));
    };
    let mut args = args;
    strip_unknown(&tool.input_schema, &mut args);
    if let Err(e) = tool.check_input(&args) {
        return tool_failure(
            id,
            -32602,
            &format!("Input validation error: Invalid arguments for tool {name}: {e}"),
        );
    }
    let result = host.call(name, args).await;
    if !result.is_error && tool.has_output_schema() {
        match &result.structured {
            None => {
                return tool_failure(
                    id,
                    -32602,
                    &format!("Tool {name} has an output schema but no structured content was provided"),
                );
            }
            Some(s) => {
                if let Err(e) = tool.check_output(s) {
                    return tool_failure(
                        id,
                        -32602,
                        &format!("Structured content does not match the tool's output schema: {e}"),
                    );
                }
            }
        }
    }
    tool_result(id, &result)
}

/// Xử lý một POST tới `/mcp` đã xác thực: thương lượng `Accept`/`Content-Type`/`Mcp-Protocol-Version`, phân tích JSON-RPC, gọi
/// phương thức. Không batch (controller chặn trước).
pub async fn handle(frozen: &Frozen, host: &dyn ToolHost, req: &Req<'_>) -> Reply {
    if !accept_ok(req.accept) {
        return transport_error(
            406,
            -32000,
            "Not Acceptable: Client must accept both application/json and text/event-stream",
        );
    }
    if !req.content_type.is_some_and(|c| c.contains("application/json")) {
        return transport_error(
            415,
            -32000,
            "Unsupported Media Type: Content-Type must be application/json",
        );
    }
    let msg: Value = match serde_json::from_slice(req.body) {
        Ok(v) => v,
        Err(_) => return transport_error(400, -32700, "Parse error: Invalid JSON"),
    };
    let Some(m) = msg.as_object() else {
        return transport_error(400, -32700, "Parse error: Invalid JSON-RPC message");
    };
    if m.get("jsonrpc").and_then(Value::as_str) != Some("2.0") {
        return transport_error(400, -32700, "Parse error: Invalid JSON-RPC message");
    }
    if !is_initialize(m)
        && let Some(v) = req.protocol_version
        && !SUPPORTED_VERSIONS.contains(&v)
    {
        return transport_error(
            400,
            -32000,
            &format!(
                "Bad Request: Unsupported protocol version: {v} (supported versions: {})",
                SUPPORTED_VERSIONS.join(", ")
            ),
        );
    }
    let method = m.get("method").and_then(Value::as_str);
    let id = m.get("id").filter(|i| i.is_string() || i.is_number());
    let (Some(method), Some(id)) = (method, id) else {
        // Thông báo (không `id`) hoặc phản hồi từ client: nhận, không trả thân.
        return Reply {
            status: 202,
            body: None,
        };
    };
    let params = m.get("params");
    match method {
        "initialize" => initialize(id, params),
        "ping" => ok(id, "{}"),
        "tools/list" => ok(id, &format!("{{\"tools\":{}}}", frozen.tools_array())),
        "tools/call" => tools_call(frozen, host, id, params).await,
        _ => rpc_error(id, -32601, "Method not found"),
    }
}
