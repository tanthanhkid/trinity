import { createWriteStream } from 'node:fs';
import { mkdir, rename, unlink, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import { randomBytes } from 'node:crypto';
import { pipeline } from 'node:stream/promises';
import { PassThrough, type Readable } from 'node:stream';

/**
 * Ghi file ATOMIC: ghi ra `${targetPath}.tmp-<random>` rồi `rename` sang
 * `targetPath` (cùng filesystem → rename là 1 syscall atomic trên POSIX) —
 * tránh file nửa vời khi tiến trình bị kill giữa chừng.
 *
 * `body` là `Buffer` (payload nhỏ) hoặc `Readable` (file lớn — STREAM thẳng,
 * KHÔNG buffer toàn bộ vào RAM, giữ an toàn bộ nhớ với file lớn).
 *
 * Trả về SỐ BYTE THẬT đã ghi — dùng làm `contentLength` khi caller không biết
 * trước (an toàn hơn tin `contentLength` do caller truyền, có thể sai lệch).
 */
export async function writeAtomic(
  targetPath: string,
  body: Buffer | Readable,
): Promise<number> {
  await mkdir(dirname(targetPath), { recursive: true });
  const tmpPath = `${targetPath}.tmp-${randomBytes(8).toString('hex')}`;

  try {
    let bytesWritten: number;
    if (Buffer.isBuffer(body)) {
      await writeFile(tmpPath, body);
      bytesWritten = body.length;
    } else {
      bytesWritten = await pipeToFileCountingBytes(tmpPath, body);
    }
    await rename(tmpPath, targetPath);
    return bytesWritten;
  } catch (err) {
    await unlink(tmpPath).catch(() => undefined);
    throw err;
  }
}

async function pipeToFileCountingBytes(
  tmpPath: string,
  source: Readable,
): Promise<number> {
  let total = 0;
  const counter = new PassThrough();
  counter.on('data', (chunk: Buffer) => {
    total += chunk.length;
  });
  const dest = createWriteStream(tmpPath);
  await pipeline(source, counter, dest);
  return total;
}
