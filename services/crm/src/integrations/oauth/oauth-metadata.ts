import { ADVERTISED_SCOPES, OAUTH_SCOPES, authorizationEndpoint, issuerUrl, mcpResourceUrl } from './oauth-config';

/** RFC 8414 — metadata Authorization Server. */
export function authorizationServerMetadata(base: string): Record<string, unknown> {
  const issuer = issuerUrl(base);
  return {
    issuer,
    authorization_endpoint: authorizationEndpoint(base),
    token_endpoint: `${issuer}/token`,
    registration_endpoint: `${issuer}/register`,
    revocation_endpoint: `${issuer}/revoke`,
    scopes_supported: ADVERTISED_SCOPES,
    response_types_supported: ['code'],
    response_modes_supported: ['query'],
    grant_types_supported: ['authorization_code', 'refresh_token'],
    // Chỉ S256 (OAuth 2.1). Client phải thấy trường này mới chịu chạy (MCP spec — Authorization Code Protection).
    code_challenge_methods_supported: ['S256'],
    // Claude chỉ dùng CIMD khi cả `client_id_metadata_document_supported` VÀ `none` đều có ở đây.
    token_endpoint_auth_methods_supported: ['none', 'client_secret_post'],
    revocation_endpoint_auth_methods_supported: ['none', 'client_secret_post'],
    client_id_metadata_document_supported: true,
    // RFC 9207: `iss` luôn có trong phản hồi uỷ quyền (ChatGPT cần để dùng redirect URI ổn định).
    authorization_response_iss_parameter_supported: true,
    service_documentation: `${base}/settings`,
  };
}

/** RFC 9728 — metadata Protected Resource (máy chủ MCP). `crm.write` cho phép AI ghi dữ liệu ngay trong phạm vi quyền của người dùng (chế độ duyệt tuỳ chọn). */
export function protectedResourceMetadata(base: string): Record<string, unknown> {
  return {
    resource: mcpResourceUrl(base),
    authorization_servers: [issuerUrl(base)],
    scopes_supported: [...OAUTH_SCOPES],
    bearer_methods_supported: ['header'],
    resource_name: 'Trinity CRM (MCP)',
    resource_documentation: `${base}/settings`,
  };
}
