import { createHmac } from 'node:crypto';
import { Readable } from 'node:stream';
import { VercelBlobStorageDriver } from './vercel-blob-driver';
import { generateClientUploadToken, buildClientUploadTarget } from './vercel-blob-client-token';
import { StorageObjectNotFoundError, PresignNotSupportedError } from './types';

const TOKEN = 'vercel_blob_rw_store123_secretabc';

function mockFetch(handler: (url: string, init: RequestInit) => Response) {
  const calls: { url: string; init: RequestInit }[] = [];
  const fn = jest.fn(async (url: string | URL | Request, init?: RequestInit) => {
    calls.push({ url: String(url), init: init ?? {} });
    return handler(String(url), init ?? {});
  });
  return { fn: fn as unknown as typeof fetch, calls };
}

describe('VercelBlobStorageDriver', () => {
  it('init throw khi token sai định dạng', async () => {
    const d = new VercelBlobStorageDriver({ token: 'abc' });
    await expect(d.init()).rejects.toThrow(/BLOB_READ_WRITE_TOKEN/);
    await expect(new VercelBlobStorageDriver({ token: TOKEN }).init()).resolves.toBeUndefined();
  });

  it('upload Buffer: PUT đúng URL/header, ghi đè, không hậu tố ngẫu nhiên', async () => {
    const { fn, calls } = mockFetch(() => new Response('{"url":"x"}', { status: 200 }));
    const d = new VercelBlobStorageDriver({ token: TOKEN, fetchImpl: fn });
    const key = await d.upload('documents/a b/x.pdf', Buffer.from('hi'), 'application/pdf');
    expect(key).toBe('documents/a b/x.pdf');
    const [c] = calls;
    expect(c.url).toBe('https://vercel.com/api/blob/?pathname=documents%2Fa+b%2Fx.pdf');
    expect(c.init.method).toBe('PUT');
    const h = c.init.headers as Record<string, string>;
    expect(h.authorization).toBe(`Bearer ${TOKEN}`);
    expect(h['x-content-type']).toBe('application/pdf');
    expect(h['x-add-random-suffix']).toBe('0');
    expect(h['x-allow-overwrite']).toBe('1');
    expect(h['x-vercel-blob-access']).toBe('public');
    expect(h['x-content-length']).toBe('2');
    expect(h['x-vercel-blob-store-id']).toBe('store123');
  });

  it('upload Readable: stream + duplex half + x-content-length từ contentLength', async () => {
    const { fn, calls } = mockFetch(() => new Response('{}', { status: 200 }));
    const d = new VercelBlobStorageDriver({ token: TOKEN, fetchImpl: fn });
    await d.upload('newsfeed/v.mp4', Readable.from([Buffer.from('abc')]), 'video/mp4', 3);
    const init = calls[0].init as RequestInit & { duplex?: string };
    expect(init.duplex).toBe('half');
    expect((init.headers as Record<string, string>)['x-content-length']).toBe('3');
  });

  it('upload lỗi HTTP → throw (caller quyết retry)', async () => {
    const { fn } = mockFetch(() => new Response('forbidden', { status: 403 }));
    const d = new VercelBlobStorageDriver({ token: TOKEN, fetchImpl: fn });
    await expect(d.upload('a/b', Buffer.from('x'), 'text/plain')).rejects.toThrow(/403/);
  });

  it('chặn key traversal / tuyệt đối', async () => {
    const { fn } = mockFetch(() => new Response('', { status: 200 }));
    const d = new VercelBlobStorageDriver({ token: TOKEN, fetchImpl: fn });
    for (const k of ['../x', '/abs', 'a//b', 'a/../b', '', 'a\\b']) {
      await expect(d.upload(k, Buffer.from('x'), 't')).rejects.toThrow();
    }
  });

  it('getObjectStream đọc từ URL store kèm Bearer; 404 → NoSuchKey', async () => {
    const { fn, calls } = mockFetch((url) =>
      url.endsWith('missing.txt')
        ? new Response('', { status: 404 })
        : new Response('hello', { status: 200, headers: { 'content-type': 'text/plain', 'content-length': '5' } }),
    );
    const d = new VercelBlobStorageDriver({ token: TOKEN, access: 'private', fetchImpl: fn });
    const r = await d.getObjectStream('uploads/a.txt');
    expect(calls[0].url).toBe('https://store123.private.blob.vercel-storage.com/uploads/a.txt');
    expect((calls[0].init.headers as Record<string, string>).authorization).toBe(`Bearer ${TOKEN}`);
    const chunks: Buffer[] = [];
    for await (const c of r.body) chunks.push(Buffer.from(c));
    expect(Buffer.concat(chunks).toString()).toBe('hello');
    expect(r.contentType).toBe('text/plain');
    expect(r.contentLength).toBe(5);
    const err = await d.getObjectStream('missing.txt').catch((e) => e);
    expect(err).toBeInstanceOf(StorageObjectNotFoundError);
    expect(err.name).toBe('NoSuchKey');
  });

  it('getObjectStreamRange chuyển tiếp Range và trả 206 + Content-Range', async () => {
    const { fn, calls } = mockFetch(
      () =>
        new Response('he', {
          status: 206,
          headers: { 'content-range': 'bytes 0-1/5', 'content-length': '2' },
        }),
    );
    const d = new VercelBlobStorageDriver({ token: TOKEN, fetchImpl: fn });
    const r = await d.getObjectStreamRange('v.mp4', 'bytes=0-1');
    expect((calls[0].init.headers as Record<string, string>).range).toBe('bytes=0-1');
    expect(r.statusCode).toBe(206);
    expect(r.contentRange).toBe('bytes 0-1/5');
  });

  it('delete best-effort: POST /delete, KHÔNG throw khi lỗi', async () => {
    const warn = jest.fn();
    const { fn, calls } = mockFetch(() => new Response('boom', { status: 500 }));
    const d = new VercelBlobStorageDriver({ token: TOKEN, fetchImpl: fn }, { warn });
    await expect(d.delete('a/b.txt')).resolves.toBeUndefined();
    expect(calls[0].url).toBe('https://vercel.com/api/blob/delete');
    expect(JSON.parse(String(calls[0].init.body))).toEqual({
      urls: ['https://store123.public.blob.vercel-storage.com/a/b.txt'],
    });
    expect(warn).toHaveBeenCalled();
    const throwing = new VercelBlobStorageDriver(
      { token: TOKEN, fetchImpl: (async () => { throw new Error('net'); }) as unknown as typeof fetch },
      { warn },
    );
    await expect(throwing.delete('a/b')).resolves.toBeUndefined();
  });

  it('getPresignedUrl: public → URL công khai, private → PresignNotSupportedError', async () => {
    const pub = new VercelBlobStorageDriver({ token: TOKEN });
    await expect(pub.getPresignedUrl('a/b.png')).resolves.toBe(
      'https://store123.public.blob.vercel-storage.com/a/b.png',
    );
    const priv = new VercelBlobStorageDriver({ token: TOKEN, access: 'private' });
    await expect(priv.getPresignedUrl('a/b.png')).rejects.toBeInstanceOf(PresignNotSupportedError);
  });
});

describe('client upload token', () => {
  it('ký HMAC-SHA256 hex đúng định dạng SDK, payload chứa ràng buộc', () => {
    const t = generateClientUploadToken({
      token: TOKEN,
      pathname: 'newsfeed/v.mp4',
      maximumSizeInBytes: 40 * 1024 * 1024,
      allowedContentTypes: ['video/mp4'],
      now: 1_000,
      ttlMs: 5_000,
    });
    expect(t.startsWith('vercel_blob_client_store123_')).toBe(true);
    const decoded = Buffer.from(t.slice('vercel_blob_client_store123_'.length), 'base64').toString();
    const [sig, payloadB64] = decoded.split('.');
    expect(sig).toBe(createHmac('sha256', TOKEN).update(payloadB64).digest('hex'));
    expect(JSON.parse(Buffer.from(payloadB64, 'base64').toString())).toEqual({
      pathname: 'newsfeed/v.mp4',
      maximumSizeInBytes: 40 * 1024 * 1024,
      allowedContentTypes: ['video/mp4'],
      addRandomSuffix: false,
      allowOverwrite: false,
      validUntil: 6_000,
    });
  });

  it('buildClientUploadTarget trả URL + header cho trình duyệt', () => {
    const t = buildClientUploadTarget('vercel_blob_client_store123_xx', 'newsfeed/v.mp4', 'video/mp4', 'public');
    expect(t.upload_url).toBe('https://vercel.com/api/blob/?pathname=newsfeed%2Fv.mp4');
    expect(t.headers.authorization).toBe('Bearer vercel_blob_client_store123_xx');
    expect(t.headers['x-vercel-blob-store-id']).toBe('store123');
  });
});
