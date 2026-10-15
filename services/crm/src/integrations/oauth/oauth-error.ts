/** Lỗi OAuth theo RFC 6749 §5.2 / 4.1.2.1. `status` là HTTP status khi trả ở endpoint (token/register/revoke/consent). */
export class OAuthError extends Error {
  constructor(
    readonly code: string,
    readonly description: string,
    readonly status: number = 400,
  ) {
    super(`${code}: ${description}`);
  }

  body(): { error: string; error_description: string } {
    return { error: this.code, error_description: this.description };
  }
}

/** Lỗi ĐÃ biết redirect_uri hợp lệ ⇒ trả về cho client qua redirect (kèm `state`, `iss`) thay vì hiện trên trang. */
export class RedirectableOAuthError extends OAuthError {}
