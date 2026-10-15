import {
  S3Client,
  PutObjectCommand,
  GetObjectCommand,
  DeleteObjectCommand,
  HeadBucketCommand,
  CreateBucketCommand,
} from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import type { Readable } from 'node:stream';
import {
  type MinimalLogger,
  type ObjectStream,
  type RangedObjectStream,
  type StorageDriver,
} from './types';

export interface S3StorageDriverConfig {
  endpoint: string;
  region: string;
  accessKeyId: string;
  secretAccessKey: string;
  bucket: string;
  /** Giây — mặc định 900 (15 phút), khớp hành vi cũ. */
  presignExpirySeconds?: number;
}

const DEFAULT_PRESIGN_EXPIRY_SECONDS = 900;

/**
 * Driver S3/MinIO — GIỮ ĐƯỜNG QUAY LẠI cho `STORAGE_DRIVER=s3`.
 * Mỗi consumer tự truyền `bucket`/credential riêng
 * qua config, driver KHÔNG đọc `process.env`.
 */
export class S3StorageDriver implements StorageDriver {
  private readonly client: S3Client;
  private readonly bucket: string;
  private readonly presignExpirySeconds: number;

  constructor(
    config: S3StorageDriverConfig,
    private readonly logger: MinimalLogger = { warn: () => undefined },
  ) {
    this.bucket = config.bucket;
    this.presignExpirySeconds =
      config.presignExpirySeconds ?? DEFAULT_PRESIGN_EXPIRY_SECONDS;
    this.client = new S3Client({
      endpoint: config.endpoint,
      region: config.region,
      credentials: {
        accessKeyId: config.accessKeyId,
        secretAccessKey: config.secretAccessKey,
      },
      forcePathStyle: true,
    });
  }

  async init(): Promise<void> {
    try {
      await this.client.send(new HeadBucketCommand({ Bucket: this.bucket }));
    } catch {
      try {
        await this.client.send(new CreateBucketCommand({ Bucket: this.bucket }));
      } catch (err) {
        this.logger.warn(
          `Could not verify/create S3 bucket '${this.bucket}': ${(err as Error).message}`,
        );
      }
    }
  }

  async upload(
    key: string,
    body: Buffer | Readable,
    contentType: string,
    contentLength?: number,
  ): Promise<string> {
    await this.client.send(
      new PutObjectCommand({
        Bucket: this.bucket,
        Key: key,
        Body: body,
        ContentType: contentType,
        ...(contentLength !== undefined ? { ContentLength: contentLength } : {}),
      }),
    );
    return key;
  }

  async getPresignedUrl(key: string): Promise<string> {
    const command = new GetObjectCommand({ Bucket: this.bucket, Key: key });
    return getSignedUrl(this.client, command, {
      expiresIn: this.presignExpirySeconds,
    });
  }

  async getObjectStream(key: string): Promise<ObjectStream> {
    const response = await this.client.send(
      new GetObjectCommand({ Bucket: this.bucket, Key: key }),
    );
    if (!response.Body) {
      throw new Error(`Empty body for object: ${key}`);
    }
    return {
      body: response.Body as Readable,
      contentType: response.ContentType ?? 'application/octet-stream',
      contentLength: response.ContentLength,
    };
  }

  async getObjectStreamRange(
    key: string,
    range?: string,
  ): Promise<RangedObjectStream> {
    const response = await this.client.send(
      new GetObjectCommand({
        Bucket: this.bucket,
        Key: key,
        ...(range ? { Range: range } : {}),
      }),
    );
    if (!response.Body) {
      throw new Error(`Empty body for object: ${key}`);
    }
    const isPartial = !!range && !!response.ContentRange;
    return {
      body: response.Body as Readable,
      contentType: response.ContentType ?? 'application/octet-stream',
      contentLength: response.ContentLength,
      statusCode: isPartial ? 206 : 200,
      contentRange: response.ContentRange,
    };
  }

  async delete(key: string): Promise<void> {
    try {
      await this.client.send(
        new DeleteObjectCommand({ Bucket: this.bucket, Key: key }),
      );
    } catch (err) {
      this.logger.warn(`Could not delete object ${key}: ${(err as Error).message}`);
    }
  }
}
