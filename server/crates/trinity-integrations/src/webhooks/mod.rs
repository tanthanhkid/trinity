//! M34: webhook ra. Endpoint, chữ ký, che SĐT theo quyền chủ thể, dispatcher (outbox → delivery) và worker gửi.
//! Chưa nối route (router/auth chưa có trên `main`): các hàm trong [`endpoints`] và [`deliveries`] là thân của 10 route
//! dưới `/integrations/webhooks`.

pub mod actors;
pub mod deliveries;
pub mod dispatcher;
pub mod endpoints;
pub mod payload;
pub mod retry;
pub mod secret;
pub mod sender;
pub mod signature;
pub mod worker;
