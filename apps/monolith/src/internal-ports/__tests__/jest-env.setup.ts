// Env bắt buộc ngay lúc import module (secret cho @Internal() — fallback SERVICE_SECRET).
process.env.SERVICE_SECRET = process.env.SERVICE_SECRET ?? 'test-service-secret'
process.env.JWT_SECRET = process.env.JWT_SECRET ?? 'test-jwt-secret'
