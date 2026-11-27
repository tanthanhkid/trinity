//! Bộ đọc JSON-RPC của `/mcp` (`mod_mcp::protocol::handle`): mọi thân byte, mọi giá trị `Mcp-Protocol-Version`.
//! Bất biến: không panic; trả mã HTTP hợp lệ; có thân thì thân là JSON hợp lệ; lỗi 4xx/5xx không kèm đường dẫn nội bộ.
#![no_main]

use std::sync::LazyLock;

use futures_util::future::BoxFuture;
use libfuzzer_sys::fuzz_target;
use mod_mcp::frozen::Frozen;
use mod_mcp::protocol::{CallResult, Req, ToolHost, handle};
use serde_json::Value;

struct Stub;

impl ToolHost for Stub {
    fn call<'a>(&'a self, _name: &'a str, _args: Value) -> BoxFuture<'a, CallResult> {
        Box::pin(async { CallResult::error("stub") })
    }
}

static FROZEN: LazyLock<Frozen> = LazyLock::new(Frozen::embedded);
static RT: LazyLock<tokio::runtime::Runtime> = LazyLock::new(|| {
    tokio::runtime::Builder::new_current_thread()
        .build()
        .expect("runtime")
});

fuzz_target!(|input: (Option<String>, Vec<u8>)| {
    let (version, body) = input;
    let req = Req {
        accept: Some("application/json, text/event-stream"),
        content_type: Some("application/json"),
        protocol_version: version.as_deref(),
        body: &body,
    };
    let reply = RT.block_on(handle(&FROZEN, &Stub, &req));
    assert!((200..600).contains(&reply.status), "mã HTTP lạ: {}", reply.status);
    if let Some(b) = &reply.body {
        serde_json::from_str::<Value>(b).expect("thân trả về phải là JSON hợp lệ");
        assert!(!b.contains("/Users/") && !b.contains("panicked at"), "lộ chi tiết nội bộ");
    }
});
