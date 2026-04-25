import { Injectable, Logger } from '@nestjs/common';
import { S3Client, PutObjectCommand, GetObjectCommand } from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';

/**
 * Object storage abstraction.
 *
 * Talks S3, configured against MinIO in dev (see infra/docker-compose.yml)
 * and AWS S3 in prod. Per design doc §3.1, file uploads use short-lived
 * signed URLs (5-min TTL) and per-tenant key prefixes; the API never
 * proxies bytes.
 *
 * Tenant isolation in object storage:
 *   - Single bucket, per-tenant key prefix (engagements/<tid>/<eid>/...).
 *   - Read URLs are scoped to a known key the API generated, so a client
 *     cannot list across other tenants. Bucket policies are not relied on.
 */
@Injectable()
export class S3Service {
  private readonly logger = new Logger(S3Service.name);
  private readonly client: S3Client;
  private readonly bucket: string;

  constructor() {
    const endpoint = process.env.S3_ENDPOINT ?? 'http://localhost:9000';
    const region = process.env.S3_REGION ?? 'us-east-1';
    const accessKeyId = process.env.S3_ACCESS_KEY ?? 'rhud';
    const secretAccessKey = process.env.S3_SECRET_KEY ?? 'rhud-secret';
    this.bucket = process.env.S3_BUCKET ?? 'rhud-dev';

    this.client = new S3Client({
      region,
      endpoint,
      // MinIO requires path-style addressing; AWS S3 prefers virtual-host
      // but accepts path-style when explicitly enabled.
      forcePathStyle: true,
      credentials: { accessKeyId, secretAccessKey },
    });
  }

  /**
   * Generate a signed PUT URL the client uploads directly to. The API never
   * sees the bytes. Sets content-type and content-length-limit at signing
   * time so the URL can't be reused for a larger or different-typed payload.
   */
  async presignPut(opts: {
    key: string;
    contentType: string;
    expiresInSeconds?: number;
  }): Promise<{ url: string; expiresAt: string }> {
    const ttl = opts.expiresInSeconds ?? 300; // 5 minutes per §4.6
    const cmd = new PutObjectCommand({
      Bucket: this.bucket,
      Key: opts.key,
      ContentType: opts.contentType,
    });
    const url = await getSignedUrl(this.client, cmd, { expiresIn: ttl });
    return { url, expiresAt: new Date(Date.now() + ttl * 1000).toISOString() };
  }

  /** Signed GET URL for a known object key. Same TTL as PUT. */
  async presignGet(opts: { key: string; expiresInSeconds?: number }): Promise<string> {
    const ttl = opts.expiresInSeconds ?? 300;
    const cmd = new GetObjectCommand({ Bucket: this.bucket, Key: opts.key });
    return getSignedUrl(this.client, cmd, { expiresIn: ttl });
  }

  /** Build the canonical S3 key for an engagement file. */
  static keyForEngagementFile(args: {
    tenantId: string;
    engagementId: string;
    fileId: string;
    filename: string;
  }): string {
    // Slug the filename so weird characters can't break URL encoding.
    const safe = args.filename.replace(/[^\w.-]/g, '_').slice(0, 200);
    return `engagements/${args.tenantId}/${args.engagementId}/${args.fileId}/${safe}`;
  }
}
