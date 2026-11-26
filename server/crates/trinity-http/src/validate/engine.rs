//! `plainToInstance` của class-transformer + `validate` của class-validator + gom lỗi của `ValidationPipe` (Nest 10),
//! chạy trên [`JsVal`] theo đúng thứ tự của bản TS để mảng câu lỗi 400 giống từng phần tử.

use super::Mode;
use super::js::{JsVal, number_to_string, to_js_string, to_number};
use super::schema::{Class, MetaKind, Registry, TypeRef};

// ---------------------------------------------------------------------------------------------------------------
// class-transformer

/// `new Dto()`: trường khai trong class theo thứ tự, mang giá trị mặc định hoặc `undefined`.
fn instantiate(class: &Class) -> JsVal {
    JsVal::Obj(
        class
            .declared
            .iter()
            .map(|k| (k.clone(), class.defaults.get(k).cloned().unwrap_or(JsVal::Undefined)))
            .collect(),
    )
}

/// `plainToInstance(Dto, value)`; giá trị không phải đối tượng trả nguyên.
pub fn plain_to_class(reg: &Registry, class: &Class, value: &JsVal) -> JsVal {
    let JsVal::Obj(pairs) = value else { return value.clone() };
    let mut inst = instantiate(class);
    for (k, v) in pairs {
        let field = class.fields.get(k);
        let ty = field.and_then(|f| f.ty.as_ref());
        let mut out = transform_value(reg, v, ty);
        if let Some(f) = field {
            for t in &f.transforms {
                out = t.apply(out);
            }
        }
        inst.set(k, out);
    }
    inst
}

fn transform_value(reg: &Registry, v: &JsVal, ty: Option<&TypeRef>) -> JsVal {
    match (v, ty) {
        (JsVal::Arr(a), _) => JsVal::Arr(a.iter().map(|x| transform_value(reg, x, ty)).collect()),
        (JsVal::Undefined | JsVal::Null, Some(TypeRef::String | TypeRef::Number | TypeRef::Boolean)) => v.clone(),
        (_, Some(TypeRef::String)) => JsVal::Str(to_js_string(v)),
        (_, Some(TypeRef::Number)) => JsVal::Num(to_number(v)),
        (_, Some(TypeRef::Boolean)) => JsVal::Bool(v.truthy()),
        (JsVal::Obj(_), Some(TypeRef::Dto(d))) => match reg.class(d) {
            Some(c) => plain_to_class(reg, c, v),
            None => v.clone(),
        },
        (JsVal::Obj(pairs), _) => JsVal::Obj(
            pairs
                .iter()
                .map(|(k, x)| (k.clone(), transform_value(reg, x, None)))
                .collect(),
        ),
        _ => v.clone(),
    }
}

// ---------------------------------------------------------------------------------------------------------------
// class-validator

#[derive(Debug, Default)]
struct ErrNode {
    property: String,
    /// Khoá theo thứ tự chèn (như đối tượng JS); khoá trùng giữ vị trí cũ, đổi giá trị.
    constraints: Vec<(String, String)>,
    children: Vec<ErrNode>,
}

impl ErrNode {
    fn new(property: &str) -> Self {
        Self {
            property: property.to_owned(),
            ..Self::default()
        }
    }

    fn put(&mut self, key: &str, msg: String) {
        match self.constraints.iter_mut().find(|(k, _)| k == key) {
            Some((_, m)) => *m = msg,
            None => self.constraints.push((key.to_owned(), msg)),
        }
    }
}

struct Executor<'a> {
    reg: &'a Registry,
    mode: Mode,
}

impl Executor<'_> {
    fn execute(&self, class: Option<&Class>, obj: &mut JsVal, errors: &mut Vec<ErrNode>) {
        let Some(class) = class.filter(|c| !c.validated.is_empty()) else {
            let mut e = ErrNode::new("");
            e.put(
                "unknownValue",
                "an unknown value was passed to the validate function".into(),
            );
            errors.push(e);
            return;
        };
        // Whitelist: khoá không có metadata.
        if let JsVal::Obj(pairs) = obj {
            let extra: Vec<String> = pairs
                .iter()
                .map(|(k, _)| k.clone())
                .filter(|k| !class.validated.contains(k))
                .collect();
            for k in extra {
                match self.mode {
                    Mode::Strict => {
                        let mut e = ErrNode::new(&k);
                        e.put("whitelistValidation", format!("property {k} should not exist"));
                        errors.push(e);
                    }
                    Mode::Lenient => obj.remove(&k),
                }
            }
        }
        for prop in &class.validated {
            let mut value = obj.get(prop).clone();
            let mut node = ErrNode::new(prop);
            self.perform(class, obj, &mut value, prop, &mut node);
            errors.push(node);
            // Lenient: whitelist có thể đã xoá khoá trong đối tượng lồng.
            if matches!(value, JsVal::Obj(_) | JsVal::Arr(_)) {
                obj.set(prop, value);
            }
        }
    }

    fn perform(&self, class: &Class, obj: &JsVal, value: &mut JsVal, prop: &str, node: &mut ErrNode) {
        let Some(field) = class.fields.get(prop) else { return };
        let can = field.metas.iter().all(|m| match &m.kind {
            MetaKind::Cond(c) => c.holds(obj, value),
            _ => true,
        });
        if !can {
            return;
        }
        for m in &field.metas {
            let MetaKind::Custom { name, rule } = &m.kind else {
                continue;
            };
            let ok = match (m.each, &*value) {
                (true, JsVal::Arr(items)) => items.iter().all(|x| rule.check(x)),
                _ => rule.check(value),
            };
            if !ok {
                let template = match &m.message {
                    Some(msg) => msg.clone(),
                    None => {
                        let base = rule.default_message(value);
                        if m.each {
                            format!("each value in {base}")
                        } else {
                            base.to_owned()
                        }
                    }
                };
                node.put(name, render(&template, &m.constraint_strings, value, prop, &class.name));
            }
        }
        let nested: Vec<_> = field
            .metas
            .iter()
            .filter(|m| matches!(m.kind, MetaKind::Nested))
            .collect();
        if nested.is_empty() || *value == JsVal::Undefined {
            return;
        }
        let target = match &field.ty {
            Some(TypeRef::Dto(d)) => self.reg.class(d),
            _ => None,
        };
        for m in nested {
            self.nested(target, value, m, prop, &class.name, node);
        }
    }

    fn nested(
        &self,
        target: Option<&Class>,
        value: &mut JsVal,
        meta: &super::schema::Meta,
        prop: &str,
        class_name: &str,
        node: &mut ErrNode,
    ) {
        match value {
            JsVal::Arr(items) => {
                for (i, sub) in items.iter_mut().enumerate() {
                    let mut child = ErrNode::new(&i.to_string());
                    if *sub != JsVal::Undefined {
                        self.nested(target, sub, meta, prop, class_name, &mut child);
                    }
                    node.children.push(child);
                }
            }
            JsVal::Obj(_) => self.execute(target, value, &mut node.children),
            _ => {
                let template = meta.message.clone().unwrap_or_default();
                node.put(
                    "nestedValidation",
                    render(&template, &meta.constraint_strings, value, prop, class_name),
                );
            }
        }
    }
}

/// `replaceMessageSpecialTokens`.
fn render(template: &str, constraints: &[String], value: &JsVal, prop: &str, target: &str) -> String {
    let mut s = template.to_owned();
    for (i, c) in constraints.iter().enumerate() {
        s = s.replace(&format!("$constraint{}", i + 1), c);
    }
    let v = match value {
        JsVal::Str(x) => Some(x.clone()),
        JsVal::Bool(b) => Some(b.to_string()),
        JsVal::Num(n) => Some(number_to_string(*n)),
        _ => None,
    };
    if let Some(v) = v {
        s = s.replace("$value", &v);
    }
    s.replace("$property", prop).replace("$target", target)
}

/// `stripEmptyErrors` của class-validator: bỏ lỗi không có câu và không có con; lỗi có con mà không có câu thì mất
/// phần câu (đánh dấu bằng `None`).
fn strip(errors: Vec<ErrNode>) -> Vec<(ErrNode, bool)> {
    errors
        .into_iter()
        .filter_map(|mut e| {
            let children = strip(std::mem::take(&mut e.children));
            e.children = children.into_iter().map(|(c, _)| c).collect();
            if e.constraints.is_empty() && e.children.is_empty() {
                return None;
            }
            Some((e, true))
        })
        .collect()
}

/// `flattenValidationErrors` + `mapChildrenToValidationErrors` của `ValidationPipe`: lỗi có con thì chỉ lấy câu của
/// con (đã gắn tiền tố đường dẫn), câu của chính nó bị bỏ.
fn flatten(errors: Vec<ErrNode>) -> Vec<String> {
    fn map_children(e: &ErrNode, parent: Option<&str>, out: &mut Vec<Vec<String>>) {
        if e.children.is_empty() {
            out.push(e.constraints.iter().map(|(_, m)| m.clone()).collect());
            return;
        }
        let path = match parent {
            Some(p) => format!("{p}.{}", e.property),
            None => e.property.clone(),
        };
        for item in &e.children {
            if !item.children.is_empty() {
                map_children(item, Some(&path), out);
            }
            out.push(item.constraints.iter().map(|(_, m)| format!("{path}.{m}")).collect());
        }
    }
    let mut groups = Vec::new();
    for (e, _) in strip(errors) {
        map_children(&e, None, &mut groups);
    }
    groups.into_iter().flatten().collect()
}

/// Chạy như `ValidationPipe({ whitelist: true, forbidNonWhitelisted: strict, transform: true })` trên body/query của
/// DTO `class`. Thành công trả đối tượng đã chuyển (như `JSON.stringify(instance)`), thất bại trả mảng câu lỗi.
pub fn run(reg: &Registry, class: &Class, input: &JsVal, mode: Mode) -> Result<JsVal, Vec<String>> {
    // Nest: body null/undefined thành {}.
    let input = if input.is_nullish() {
        JsVal::Obj(Vec::new())
    } else {
        input.clone()
    };
    let mut inst = plain_to_class(reg, class, &input);
    let mut errors = Vec::new();
    let ex = Executor { reg, mode };
    if matches!(inst, JsVal::Obj(_)) {
        ex.execute(Some(class), &mut inst, &mut errors);
    } else {
        // Body không phải đối tượng (mảng, chuỗi): class-validator không thấy metadata.
        ex.execute(None, &mut inst, &mut errors);
    }
    let messages = flatten(errors);
    if messages.is_empty() { Ok(inst) } else { Err(messages) }
}
