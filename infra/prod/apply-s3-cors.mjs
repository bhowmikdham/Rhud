#!/usr/bin/env node
/**
 * One-shot: apply the prod S3 bucket CORS config (./s3-cors.json) so the
 * browser can PUT presigned uploads — document files, profile photos, and
 * workspace logos — directly to S3. The API never proxies those bytes, so the
 * bucket itself must advertise CORS for the web origins or the preflight
 * OPTIONS fails and the upload dies with "TypeError: Failed to fetch".
 *
 * Why this exists separately from deploy.sh: deploy.sh already runs
 * `aws s3api put-bucket-cors` on every deploy, but the EC2 instance role lacks
 * s3:PutBucketCors, so that step only warns and continues. This is the
 * out-of-band one-shot you run with admin credentials. It reuses the project's
 * existing @aws-sdk/client-s3, so no AWS CLI install is required.
 *
 * Usage (credentials come from the standard AWS provider chain):
 *   AWS_ACCESS_KEY_ID=... AWS_SECRET_ACCESS_KEY=... AWS_REGION=ap-south-1 \
 *     node infra/prod/apply-s3-cors.mjs
 *
 * Env overrides:
 *   S3_UPLOAD_BUCKET  default: rhud-uploads-prod-bhowmik  (matches deploy.sh)
 *   AWS_REGION        default: ap-south-1
 */
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { dirname, join } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url)); // infra/prod
const repoRoot = join(here, '..', '..');
const apiDir = join(repoRoot, 'apps', 'api');

// @aws-sdk/client-s3 is an apps/api dependency and pnpm doesn't hoist it to the
// repo root, so resolve it explicitly from there rather than relying on the
// bare-specifier walk from this file's location.
const require = createRequire(import.meta.url);
let sdkUrl;
try {
  sdkUrl = pathToFileURL(require.resolve('@aws-sdk/client-s3', { paths: [apiDir] })).href;
} catch {
  console.error('✗ Could not resolve @aws-sdk/client-s3. Run `pnpm install` first.');
  process.exit(1);
}
const { S3Client, PutBucketCorsCommand, GetBucketCorsCommand } = await import(sdkUrl);

const BUCKET = process.env.S3_UPLOAD_BUCKET ?? 'rhud-uploads-prod-bhowmik';
const REGION = process.env.AWS_REGION ?? 'ap-south-1';
const corsPath = join(here, 's3-cors.json');

const cors = JSON.parse(readFileSync(corsPath, 'utf8'));
if (!Array.isArray(cors.CORSRules) || cors.CORSRules.length === 0) {
  console.error(`✗ ${corsPath} has no CORSRules`);
  process.exit(1);
}

const r0 = cors.CORSRules[0];
console.log(`→ Applying CORS to s3://${BUCKET} (${REGION}) from ${corsPath}`);
console.log(
  `  rules: ${cors.CORSRules.length} | methods: ${r0.AllowedMethods.join(',')} | origins: ${r0.AllowedOrigins.join(', ')}`,
);

const client = new S3Client({ region: REGION });

try {
  await client.send(new PutBucketCorsCommand({ Bucket: BUCKET, CORSConfiguration: cors }));
} catch (err) {
  console.error(`✗ PutBucketCors failed: ${err.name}: ${err.message}`);
  if (err.name === 'AccessDenied' || /AccessDenied/.test(String(err))) {
    console.error('  These credentials need s3:PutBucketCors on this bucket.');
  }
  if (/Credential|credential|not load|missing/.test(String(err.message))) {
    console.error('  No AWS credentials found — set AWS_ACCESS_KEY_ID / AWS_SECRET_ACCESS_KEY (or AWS_PROFILE).');
  }
  process.exit(1);
}

// Read it back so the output proves what's actually live on the bucket.
const live = await client.send(new GetBucketCorsCommand({ Bucket: BUCKET }));
console.log('✓ CORS applied. Live bucket config:');
console.log(JSON.stringify(live.CORSRules, null, 2));
