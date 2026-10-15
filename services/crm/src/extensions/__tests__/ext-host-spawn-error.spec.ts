import { ExtHost } from '../runner/ext-host';

describe('ExtHost — deno thiếu / sai đường dẫn', () => {
  it('ENOENT không thành uncaughtException: ensureUp reject và host chuyển failed', async () => {
    const host = new ExtHost({ denoBin: '/nonexistent/deno-binary', memoryMb: 128 });
    const uncaught = jest.fn();
    process.once('uncaughtException', uncaught);
    await expect(host.ensureUp()).rejects.toThrow(/không khởi động được|thoát trước/);
    expect(host.isFailed).toBe(true);
    process.removeListener('uncaughtException', uncaught);
    expect(uncaught).not.toHaveBeenCalled();
    await host.stop();
  });
});
