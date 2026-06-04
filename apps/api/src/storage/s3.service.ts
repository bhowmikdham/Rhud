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
    // S3_ENDPOINT is set only when targeting a non-AWS S3 (MinIO in dev).
    // Leaving it unset in prod makes the SDK use real AWS S3 endpoints.
    const endpoint = process.env.S3_ENDPOINT;
    const region = process.env.S3_REGION ?? 'us-east-1';
    const accessKeyId = process.env.S3_ACCESS_KEY;
    const secretAccessKey = process.env.S3_SECRET_KEY;
    this.bucket = process.env.S3_BUCKET ?? 'rhud-dev';

    // MinIO requires path-style addressing; AWS S3 accepts it too but
    // prefers virtual-host. Only force path-style when we know we're
    // talking to a non-AWS endpoint.
    const config: ConstructorParameters<typeof S3Client>[0] = {
      region,
      forcePathStyle: Boolean(endpoint),
    };
    if (endpoint) config.endpoint = endpoint;
    if (accessKeyId && secretAccessKey) {
      config.credentials = { accessKeyId, secretAccessKey };
    }
    // If no credentials are set explicitly, the SDK falls back to its
    // default provider chain (env vars → shared config → EC2 instance
    // role → ECS task role). In prod we rely on the EC2 instance role.

    this.client = new S3Client(config);
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

  /**
   * Fetch the raw bytes of an object server-side. Used by the document
   * extraction pipeline — the API needs to read the file to feed it
   * through pdf-parse / exceljs / the LLM. Streamed via the SDK so we
   * stay off any signed-URL detour.
   */
  async fetchBytes(key: string): Promise<Buffer> {
    // Two layers of resilience around `GetObject`:
    //   1. **Eventual-consistency races** — a client just PUT the file
    //      and our extraction pipeline races to read it. S3 is read-
    //      after-write consistent for new objects but proxies (MinIO,
    //      LocalStack) sometimes lag a few hundred ms.
    //   2. **Transient 5xx / network errors** — flake on the wire.
    // We retry up to 3 times with exponential backoff (250ms, 500ms,
    // 1s) on retryable errors. NoSuchKey (404) after the first attempt
    // is still treated as retryable for the eventual-consistency case;
    // after the third try we surface it as `not_yet_consistent` so the
    // extraction service knows to push the file into the retry queue.
    const RETRYABLE_NAMES = new Set(['NoSuchKey', 'NetworkingError', 'TimeoutError', 'AbortError']);
    const RETRY_DELAYS_MS = [250, 500, 1000];
    let lastErr: unknown;
    for (let attempt = 0; attempt <= RETRY_DELAYS_MS.length; attempt++) {
      try {
        const cmd = new GetObjectCommand({ Bucket: this.bucket, Key: key });
        const res = await this.client.send(cmd);
        if (!res.Body) {
          throw new Error(`s3 fetchBytes: empty body for key=${key}`);
        }
        const arr = await (res.Body as { transformToByteArray(): Promise<Uint8Array> }).transformToByteArray();
        return Buffer.from(arr);
      } catch (err) {
        lastErr = err;
        const e = err as { name?: string; $metadata?: { httpStatusCode?: number } };
        const httpStatus = e.$metadata?.httpStatusCode ?? 0;
        const retryable =
          (e.name && RETRYABLE_NAMES.has(e.name)) ||
          httpStatus === 404 ||
          httpStatus >= 500;
        if (!retryable || attempt >= RETRY_DELAYS_MS.length) break;
        await new Promise((r) => setTimeout(r, RETRY_DELAYS_MS[attempt]));
      }
    }
    // Tag the final error so the extraction service can route to the
    // retry queue rather than marking the file permanently `failed`.
    const final = lastErr instanceof Error
      ? lastErr
      : new Error(String(lastErr));
    (final as Error & { retryable?: boolean }).retryable = true;
    throw final;
  }

  /**
   * Write a small buffer (≤ ~5MB) directly from the API process to S3.
   * Used by paths where the API legitimately holds the bytes — e.g. a
   * paste-text ingestion (the rep's pasted body is materialised as a
   * tiny .txt object so the extraction pipeline can run unchanged).
   *
   * For large or rep-uploaded files, use `presignPut` and let the
   * client upload directly. This method bypasses the no-API-proxy
   * principle and should not be called on the request hot path for
   * arbitrary user-provided bytes.
   */
  async putBytes(opts: {
    key: string;
    contentType: string;
    body: Buffer | Uint8Array | string;
  }): Promise<void> {
    const cmd = new PutObjectCommand({
      Bucket: this.bucket,
      Key: opts.key,
      ContentType: opts.contentType,
      Body: typeof opts.body === 'string' ? Buffer.from(opts.body, 'utf8') : opts.body,
    });
    await this.client.send(cmd);
  }

  /**
   * Canonical S3 key for an ingestion artifact's bytes. Mirrors
   * `keyForEngagementFile`'s shape but is tenant-scoped at the top
   * level since artifacts may exist before an engagement does
   * (webhook-arrived, pending promotion). Once promoted, the
   * EngagementFile created from the artifact re-uses this key — no
   * server-to-server copy needed.
   */
  static keyForIngestionArtifact(args: {
    tenantId: string;
    artifactId: string;
    filename: string;
  }): string {
    const safe = args.filename.replace(/[^\w.-]/g, '_').slice(0, 200);
    return `ingestion/${args.tenantId}/${args.artifactId}/${safe}`;
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

  /**
   * Canonical S3 key for a user's profile photo. The `uploadId` (a fresh
   * uuid per upload) busts any CDN/browser cache when the avatar is
   * replaced. Tenant + user prefix keeps isolation consistent with the
   * other key builders and lets `updateMyProfile` verify a submitted key
   * actually belongs to the caller before persisting it.
   */
  static keyForUserAvatar(args: {
    tenantId: string;
    userId: string;
    uploadId: string;
    filename: string;
  }): string {
    const safe = args.filename.replace(/[^\w.-]/g, '_').slice(0, 200);
    return `avatars/${args.tenantId}/${args.userId}/${args.uploadId}/${safe}`;
  }

  /** Prefix every avatar key for a given user shares — used to validate
   *  a client-submitted key belongs to that user before we persist it. */
  static avatarPrefixForUser(args: { tenantId: string; userId: string }): string {
    return `avatars/${args.tenantId}/${args.userId}/`;
  }

  /** Canonical S3 key for a workspace logo. Tenant-prefixed; `uploadId`
   *  busts cache on replace. */
  static keyForTenantLogo(args: {
    tenantId: string;
    uploadId: string;
    filename: string;
  }): string {
    const safe = args.filename.replace(/[^\w.-]/g, '_').slice(0, 200);
    return `branding/${args.tenantId}/${args.uploadId}/${safe}`;
  }

  /** Prefix every logo key for a tenant shares — used to validate a
   *  client-submitted key belongs to that tenant before persisting. */
  static logoPrefixForTenant(args: { tenantId: string }): string {
    return `branding/${args.tenantId}/`;
  }
}
