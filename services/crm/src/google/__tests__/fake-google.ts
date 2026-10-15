import { GoogleHttp, type GoogleHttpRequest, type GoogleHttpResponse } from '../google-http';

/** Google giả: bắt mọi request, trả theo bảng định tuyến. KHÔNG có mạng. */
export class FakeGoogleHttp extends GoogleHttp {
  calls: GoogleHttpRequest[] = [];
  tabs: Record<string, string[][]> = {};
  tokenStatus = 200;
  tokenBody: unknown = { access_token: 'AT-1', refresh_token: 'RT-1', expires_in: 3600, id_token: `x.${Buffer.from(JSON.stringify({ email: 'ceo@congty.vn' })).toString('base64url')}.y`, scope: 'a b' };

  async request(req: GoogleHttpRequest): Promise<GoogleHttpResponse> {
    this.calls.push(req);
    if (req.url.includes('/token')) return { status: this.tokenStatus, json: this.tokenBody };
    if (req.url.includes('/revoke')) return { status: 200, json: {} };
    const tab = decodeURIComponent(/values\/'([^']+)'/.exec(req.url)?.[1] ?? '');
    if (req.method === 'GET' && req.url.includes('/values/')) {
      const max = Number(/A1:[A-Z]+(\d+)/.exec(decodeURIComponent(req.url))?.[1] ?? 9999);
      return { status: 200, json: { values: (this.tabs[tab] ?? []).slice(0, max) } };
    }
    if (req.method === 'POST' && req.url.includes(':append')) {
      this.tabs[tab] = [...(this.tabs[tab] ?? []), ...((req.json as { values: string[][] }).values)];
      return { status: 200, json: {} };
    }
    if (req.method === 'GET') return { status: 200, json: { properties: { title: 'Sheet thử' }, sheets: Object.keys(this.tabs).map((t) => ({ properties: { title: t } })) } };
    if (req.method === 'POST') return { status: 200, json: { spreadsheetId: 'NEWSHEET'.padEnd(24, 'x'), spreadsheetUrl: 'https://docs.google.com/spreadsheets/d/NEW' } };
    return { status: 404, json: { error: { message: 'not found' } } };
  }
}
