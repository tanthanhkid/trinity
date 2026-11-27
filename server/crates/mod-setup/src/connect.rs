//! `GET /setup/connect-prompt`: prompt "nối Trinity" cho từng agent (`connect-prompts.ts`). Nội dung nhúng từ danh mục (sinh từ mã
//! TS) với địa chỉ MCP thành dấu hiệu, thay bằng địa chỉ thật của hệ thống.

use serde_json::{Value, json};
use trinity_integrations::status::{mcp_resource_url, oauth_enabled, public_base_url};
use trinity_kernel::error::HttpError;

use crate::catalog::catalog;
use crate::{Ctx, R};

pub fn is_agent(key: &str) -> bool {
    catalog().connect.agents.iter().any(|a| a.key == key)
}

/// `buildConnectPrompt`.
pub fn build_prompt(agent: &str, mcp_url: &str) -> Option<String> {
    let c = &catalog().connect;
    c.prompts.get(agent).map(|p| p.replace(&c.url_mark, mcp_url))
}

/// Địa chỉ MCP của hệ thống nếu máy chủ bật kết nối AI.
pub fn mcp_url(ctx: &Ctx) -> Option<String> {
    let env = |k: &str| ctx.env(k);
    if !oauth_enabled(&env) {
        return None;
    }
    public_base_url(&env).map(|b| mcp_resource_url(&b))
}

/// `GET /setup/connect-prompt?agent=`: agent lạ ⇒ `other`; máy chủ chưa bật ⇒ 404.
pub fn get(ctx: &Ctx, agent: Option<&str>) -> R<Value> {
    let Some(url) = mcp_url(ctx) else {
        return Err(HttpError::not_found("Máy chủ chưa bật kết nối AI").into());
    };
    let key = agent.filter(|a| is_agent(a)).unwrap_or("other");
    let agents: Vec<Value> = catalog()
        .connect
        .agents
        .iter()
        .map(|a| json!({ "key": a.key, "label": a.label }))
        .collect();
    Ok(json!({ "agent": key, "agents": agents, "mcp_url": url, "prompt": build_prompt(key, &url) }))
}

#[cfg(test)]
mod tests {
    use super::*;

    const URL: &str = "https://crm.example.com/api/v1/mcp";

    #[test]
    fn prompt_theo_agent() {
        for a in &catalog().connect.agents {
            let p = build_prompt(&a.key, URL).unwrap();
            assert!(
                p.contains(URL) && !p.contains(&catalog().connect.url_mark) && !p.contains("{URL}"),
                "{}",
                a.key
            );
            assert!(p.contains("OAuth 2.1") && p.contains("get_setup_guide") && p.contains("KHÔNG hỏi mình token"));
        }
        assert!(
            build_prompt("claude_code", URL)
                .unwrap()
                .contains(&format!("claude mcp add --transport http --scope user trinity {URL}"))
        );
        assert!(!build_prompt("chatgpt", URL).unwrap().contains("mcp-remote"));
        assert!(is_agent("antigravity") && !is_agent("x"));
    }
}
