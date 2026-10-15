import { StorageService } from './storage.service';

// chọn driver theo STORAGE_DRIVER và cấp token client-upload.
describe('StorageService', () => {
  const OLD = { ...process.env };
  afterEach(() => {
    process.env = { ...OLD };
    jest.restoreAllMocks();
  });

  it('mặc định (local) không hỗ trợ client upload', () => {
    delete process.env.STORAGE_DRIVER;
    const s = new StorageService();
    expect(s.isClientUploadSupported()).toBe(false);
    expect(() => s.createClientUpload('newsfeed/a.mp4', 'video/mp4', 10)).toThrow(/vercel-blob/);
  });

  it('vercel-blob: upload đi qua REST Blob, client upload trả URL + header + token', async () => {
    process.env.STORAGE_DRIVER = 'vercel-blob';
    process.env.BLOB_READ_WRITE_TOKEN = 'vercel_blob_rw_st1_testtoken';
    const fetchMock = jest
      .spyOn(globalThis, 'fetch')
      .mockResolvedValue(new Response('{}', { status: 200 }));
    const s = new StorageService();
    expect(s.isClientUploadSupported()).toBe(true);
    await s.upload('contracts/a.pdf', Buffer.from('x'), 'application/pdf');
    expect(String(fetchMock.mock.calls[0][0])).toContain('https://vercel.com/api/blob/?pathname=contracts%2Fa.pdf');

    const t = s.createClientUpload('newsfeed/u1_1_a.mp4', 'video/mp4', 1024);
    expect(t.upload_url).toContain('pathname=newsfeed%2Fu1_1_a.mp4');
    expect(t.headers.authorization).toMatch(/^Bearer vercel_blob_client_st1_/);
    expect(t.headers['x-content-type']).toBe('video/mp4');
  });

  it('vercel-blob thiếu token → throw LOUD khi dựng service', () => {
    process.env.STORAGE_DRIVER = 'vercel-blob';
    delete process.env.BLOB_READ_WRITE_TOKEN;
    expect(() => new StorageService()).toThrow(/BLOB_READ_WRITE_TOKEN/);
  });
});
