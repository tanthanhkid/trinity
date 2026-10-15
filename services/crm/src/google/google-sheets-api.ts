import { BadGatewayException, Injectable } from '@nestjs/common';
import { GOOGLE_SHEETS_BASE } from './google-config';
import { GoogleHttp, googleErrorMessage, type GoogleHttpResponse } from './google-http';

export interface SheetMeta {
  title: string;
  tabs: string[];
}

/** Nhận URL Google Sheet hoặc chính ID; trả ID hoặc null. */
export function parseSpreadsheetId(input: string): string | null {
  const s = input.trim();
  const m = /\/spreadsheets\/d\/([A-Za-z0-9_-]{20,})/.exec(s);
  if (m) return m[1];
  return /^[A-Za-z0-9_-]{20,}$/.test(s) ? s : null;
}

/** Tên tab → dạng dùng trong A1 notation (bọc nháy đơn, nhân đôi nháy đơn bên trong). */
export function a1Tab(tab: string): string {
  return `'${tab.replace(/'/g, "''")}'`;
}

/** Số cột (1-based) → chữ cột A1 (1→A, 27→AA). */
export function columnLetter(n: number): string {
  let s = '';
  for (let x = n; x > 0; x = Math.floor((x - 1) / 26)) s = String.fromCharCode(65 + ((x - 1) % 26)) + s;
  return s;
}

export const MAX_IMPORT_ROWS = 5000;
export const MAX_COLS = 52;

/** Gọi Google Sheets API v4. Mọi hàm nhận access token đã làm mới; lỗi Google → 502 kèm thông báo rút gọn. */
@Injectable()
export class GoogleSheetsApi {
  constructor(private readonly http: GoogleHttp) {}

  private ensure(res: GoogleHttpResponse): unknown {
    if (res.status < 200 || res.status >= 300) throw new BadGatewayException(googleErrorMessage(res.json, res.status));
    return res.json;
  }

  private auth(token: string): Record<string, string> {
    return { authorization: `Bearer ${token}` };
  }

  async meta(token: string, id: string): Promise<SheetMeta> {
    const res = await this.http.request({ method: 'GET', url: `${GOOGLE_SHEETS_BASE}/${id}?fields=properties.title,sheets.properties.title`, headers: this.auth(token) });
    const j = this.ensure(res) as { properties?: { title?: string }; sheets?: { properties?: { title?: string } }[] };
    return { title: j.properties?.title ?? '', tabs: (j.sheets ?? []).map((s) => s.properties?.title ?? '').filter(Boolean) };
  }

  /** Đọc tab từ dòng 1 (tối đa MAX_IMPORT_ROWS dòng × MAX_COLS cột). Ô thiếu = chuỗi rỗng ở cuối dòng bị Google cắt. */
  async values(token: string, id: string, tab: string, maxRows = MAX_IMPORT_ROWS): Promise<string[][]> {
    const range = encodeURIComponent(`${a1Tab(tab)}!A1:${columnLetter(MAX_COLS)}${maxRows + 1}`);
    const res = await this.http.request({
      method: 'GET',
      url: `${GOOGLE_SHEETS_BASE}/${id}/values/${range}?majorDimension=ROWS&valueRenderOption=FORMATTED_VALUE`,
      headers: this.auth(token),
    });
    const j = this.ensure(res) as { values?: unknown[][] };
    return (j.values ?? []).map((r) => r.map((c) => (c == null ? '' : String(c))));
  }

  /** Thêm dòng vào cuối tab (USER_ENTERED để Google tự nhận ngày/số như gõ tay). */
  async append(token: string, id: string, tab: string, rows: string[][]): Promise<void> {
    if (rows.length === 0) return;
    const range = encodeURIComponent(`${a1Tab(tab)}!A1`);
    const res = await this.http.request({
      method: 'POST',
      url: `${GOOGLE_SHEETS_BASE}/${id}/values/${range}:append?valueInputOption=RAW&insertDataOption=INSERT_ROWS`,
      headers: this.auth(token),
      json: { majorDimension: 'ROWS', values: rows },
    });
    this.ensure(res);
  }

  /** Tạo Sheet mới (cho phép xuất mà chưa có file) — chỉ động tới file do app tạo (drive.file). */
  async create(token: string, title: string, tab: string): Promise<{ id: string; url: string }> {
    const res = await this.http.request({
      method: 'POST',
      url: GOOGLE_SHEETS_BASE,
      headers: this.auth(token),
      json: { properties: { title }, sheets: [{ properties: { title: tab } }] },
    });
    const j = this.ensure(res) as { spreadsheetId?: string; spreadsheetUrl?: string };
    if (!j.spreadsheetId) throw new BadGatewayException('Google không trả ID Sheet vừa tạo');
    return { id: j.spreadsheetId, url: j.spreadsheetUrl ?? `https://docs.google.com/spreadsheets/d/${j.spreadsheetId}` };
  }
}
