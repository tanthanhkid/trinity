//! Danh mục nhúng từ `contracts/setup/catalog.json` (sinh bởi `apps/monolith/src/__tests__/setup-catalog-contract.spec.ts`
//! từ mã TS): mẫu bảng dựng sẵn + bản ghi mẫu, ngành + phân hệ gợi ý, prompt nối từng agent.

use std::sync::LazyLock;

use serde::Deserialize;
use serde_json::{Map, Value};

#[derive(Debug, Deserialize)]
pub struct Catalog {
    pub templates: Vec<Template>,
    pub industries: Vec<Industry>,
    pub locked_features: Vec<String>,
    pub max_build_features: usize,
    pub connect: Connect,
}

#[derive(Debug, Deserialize)]
pub struct Template {
    pub key: String,
    pub label: String,
    pub description: String,
    pub objects: Vec<TObject>,
    pub samples: Vec<Sample>,
}

#[derive(Debug, Deserialize)]
pub struct TObject {
    pub key: String,
    pub label: String,
    pub label_plural: String,
    pub icon: String,
    pub description: String,
    pub fields: Vec<TField>,
}

#[derive(Debug, Deserialize)]
pub struct TField {
    pub key: String,
    pub label: String,
    #[serde(rename = "type")]
    pub kind: String,
    #[serde(default)]
    pub required: bool,
    #[serde(default)]
    pub is_unique: bool,
    #[serde(default)]
    pub is_title: bool,
    #[serde(default = "yes")]
    pub show_in_list: bool,
    pub help_text: Option<String>,
    pub choices: Option<Vec<Value>>,
    /// Khoá thực thể đích trong mẫu, hoặc `contact` (Danh bạ).
    pub relation: Option<String>,
    pub multiple: Option<bool>,
    pub expression: Option<String>,
    pub format: Option<String>,
    pub decimals: Option<i64>,
}

fn yes() -> bool {
    true
}

/// Bản ghi mẫu GIẢ: `data` theo khoá trường (chuỗi `{today}` = ngày hôm nay giờ VN; `{"$add_months": "<trường>"}`),
/// `refs` = chỉ số (0-based) bản ghi mẫu cùng thực thể đích.
#[derive(Debug, Deserialize)]
pub struct Sample {
    pub object: String,
    pub data: Map<String, Value>,
    pub refs: Option<Map<String, Value>>,
}

#[derive(Debug, Deserialize)]
pub struct Industry {
    pub key: String,
    pub label: String,
    pub description: String,
    pub icon: String,
    pub template: Option<String>,
    pub features: Vec<String>,
}

#[derive(Debug, Deserialize)]
pub struct Connect {
    pub url_mark: String,
    pub agents: Vec<Agent>,
    pub prompts: std::collections::BTreeMap<String, String>,
}

#[derive(Debug, Deserialize)]
pub struct Agent {
    pub key: String,
    pub label: String,
}

static CATALOG: LazyLock<Catalog> = LazyLock::new(|| {
    serde_json::from_str(include_str!("../../../contracts/setup/catalog.json"))
        .expect("contracts/setup/catalog.json hợp lệ")
});

pub fn catalog() -> &'static Catalog {
    &CATALOG
}

pub fn find_template(key: &str) -> Option<&'static Template> {
    catalog().templates.iter().find(|t| t.key == key)
}
