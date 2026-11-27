//! Tính tiền POS: HÀM THUẦN, số nguyên VND (`i64`). BE là nguồn duy nhất của mọi tổng tiền: client không gửi giá hay
//! tổng, chỉ gửi id và số lượng. Bản TS: `pos-money.util.ts`.

// AppError/HttpError của kernel là kiểu lỗi chung của handler; giữ nguyên, không bọc Box.
#![allow(clippy::result_large_err)]

use serde::{Deserialize, Serialize};
use trinity_kernel::error::HttpError;

use crate::MAX_MONEY;

/// Ảnh chụp một tuỳ chọn món lúc bán (`options` của dòng đơn).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct ModifierSnapshot {
    pub id: i32,
    pub group_name: String,
    pub name: String,
    pub price_delta: i64,
}

fn assert_money(n: Option<i64>, label: &str) -> Result<i64, HttpError> {
    match n {
        Some(v) if (0..=MAX_MONEY).contains(&v) => Ok(v),
        _ => Err(HttpError::bad_request(format!(
            "{label} không hợp lệ hoặc vượt giới hạn"
        ))),
    }
}

/// `(đơn giá + Σ price_delta) × số lượng`; đơn giá sau tuỳ chọn âm ⇒ 400; vượt trần ⇒ 400.
pub fn calc_line_total(unit_price: i64, mods: &[ModifierSnapshot], quantity: i64) -> Result<i64, HttpError> {
    let unit = mods.iter().try_fold(unit_price, |s, m| s.checked_add(m.price_delta));
    let unit = unit.ok_or_else(|| HttpError::bad_request("Thành tiền không hợp lệ hoặc vượt giới hạn"))?;
    if unit < 0 {
        return Err(HttpError::bad_request("Đơn giá sau tuỳ chọn không được âm"));
    }
    assert_money(unit.checked_mul(quantity), "Thành tiền")
}

/// Số tiền giảm: `percent` làm tròn xuống; `amount` không vượt tạm tính.
pub fn calc_discount(subtotal: i64, kind: &str, value: i64) -> Result<i64, HttpError> {
    match kind {
        "percent" => {
            if value < 0 {
                return Err(HttpError::bad_request("Giá trị giảm giá không hợp lệ"));
            }
            if value > 100 {
                return Err(HttpError::bad_request("Giảm giá phần trăm tối đa 100"));
            }
            Ok(i64::try_from(i128::from(subtotal) * i128::from(value) / 100).unwrap_or(i64::MAX))
        }
        "amount" => {
            if value < 0 {
                return Err(HttpError::bad_request("Giá trị giảm giá không hợp lệ"));
            }
            if value > subtotal {
                return Err(HttpError::bad_request("Giảm giá không được lớn hơn tạm tính"));
            }
            Ok(value)
        }
        _ => Ok(0),
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct OrderTotals {
    pub subtotal: i64,
    pub discount_amount: i64,
    pub total: i64,
}

pub fn calc_totals(lines: &[i64], kind: &str, value: i64) -> Result<OrderTotals, HttpError> {
    let sum = lines.iter().try_fold(0_i64, |s, n| s.checked_add(*n));
    let subtotal = assert_money(sum, "Tạm tính")?;
    let discount_amount = calc_discount(subtotal, kind, value)?;
    Ok(OrderTotals {
        subtotal,
        discount_amount,
        total: subtotal - discount_amount,
    })
}

/// Một dòng thanh toán đầu vào (`PaymentInputDto`).
#[derive(Debug, Clone, Deserialize)]
pub struct PaymentInput {
    pub method: String,
    pub amount: i64,
    #[serde(default)]
    pub tendered: Option<i64>,
    #[serde(default)]
    pub reference: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct PaymentRow {
    pub method: String,
    pub amount: i64,
    pub tendered: Option<i64>,
    pub change: i64,
    pub reference: Option<String>,
}

/// Chuẩn hoá dòng thanh toán: tổng `amount` PHẢI đúng bằng `total`; tiền mặt tính tiền thối.
pub fn build_payment_rows(inputs: &[PaymentInput], total: i64) -> Result<Vec<PaymentRow>, HttpError> {
    if total == 0 && inputs.is_empty() {
        return Ok(Vec::new());
    }
    if inputs.is_empty() {
        return Err(HttpError::bad_request("Cần ít nhất một dòng thanh toán"));
    }
    let rows = inputs.iter().map(to_payment_row).collect::<Result<Vec<_>, _>>()?;
    let paid: i64 = rows.iter().map(|r| r.amount).sum();
    if paid != total {
        return Err(HttpError::bad_request(format!(
            "Tổng thanh toán {paid} phải đúng bằng tổng đơn {total}"
        )));
    }
    Ok(rows)
}

fn to_payment_row(p: &PaymentInput) -> Result<PaymentRow, HttpError> {
    assert_money(Some(p.amount), "Số tiền thanh toán")?;
    if p.amount == 0 {
        return Err(HttpError::bad_request("Số tiền thanh toán phải lớn hơn 0"));
    }
    let reference = p
        .reference
        .as_deref()
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .map(str::to_owned);
    if p.method != "cash" {
        return Ok(PaymentRow {
            method: p.method.clone(),
            amount: p.amount,
            tendered: None,
            change: 0,
            reference,
        });
    }
    let tendered = assert_money(Some(p.tendered.unwrap_or(p.amount)), "Tiền khách đưa")?;
    if tendered < p.amount {
        return Err(HttpError::bad_request("Tiền khách đưa chưa đủ"));
    }
    Ok(PaymentRow {
        method: "cash".into(),
        amount: p.amount,
        tendered: Some(tendered),
        change: tendered - p.amount,
        reference,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn m(d: i64) -> ModifierSnapshot {
        ModifierSnapshot {
            id: 1,
            group_name: "g".into(),
            name: "n".into(),
            price_delta: d,
        }
    }
    fn pay(method: &str, amount: i64, tendered: Option<i64>) -> PaymentInput {
        PaymentInput {
            method: method.into(),
            amount,
            tendered,
            reference: None,
        }
    }

    #[test]
    fn dong_tien_va_giam_gia() {
        assert_eq!(calc_line_total(30_000, &[m(5_000), m(-2_000)], 3).unwrap(), 99_000);
        assert!(calc_line_total(1_000, &[m(-2_000)], 1).is_err());
        assert!(calc_line_total(MAX_MONEY, &[], 2).is_err());
        assert_eq!(calc_discount(99_999, "percent", 10).unwrap(), 9_999);
        assert_eq!(calc_discount(1_000, "amount", 1_000).unwrap(), 1_000);
        assert!(calc_discount(1_000, "amount", 1_001).is_err());
        assert!(calc_discount(1_000, "percent", 101).is_err());
        assert_eq!(calc_discount(1_000, "none", 99).unwrap(), 0);
        let t = calc_totals(&[10_000, 25_500], "percent", 15).unwrap();
        assert_eq!((t.subtotal, t.discount_amount, t.total), (35_500, 5_325, 30_175));
    }

    #[test]
    fn thanh_toan_tien_mat_thoi_tien_va_tong_khop() {
        let r = build_payment_rows(
            &[pay("cash", 60_000, Some(100_000)), pay("bank_transfer", 40_000, None)],
            100_000,
        )
        .unwrap();
        assert_eq!(
            (r[0].tendered, r[0].change, r[1].tendered),
            (Some(100_000), 40_000, None)
        );
        assert!(build_payment_rows(&[pay("cash", 60_000, None)], 100_000).is_err());
        assert!(build_payment_rows(&[pay("cash", 60_000, Some(50_000))], 60_000).is_err());
        assert!(build_payment_rows(&[], 5).is_err());
        assert!(build_payment_rows(&[], 0).unwrap().is_empty());
        assert_eq!(
            build_payment_rows(&[pay("cash", 7, None)], 7).unwrap()[0].tendered,
            Some(7)
        );
    }
}
