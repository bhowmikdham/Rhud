/**
 * Shared constraints for browser-uploaded images (user avatars, workspace
 * logos). Used by the presign endpoints to reject non-image content types
 * before handing back a signed PUT url.
 *
 * Note: like the existing ingest/engagement-file flows, byte-size is not
 * cryptographically enforced at the S3 layer (the presigned PUT only pins
 * Content-Type). The client caps size before upload; this is a UX guard,
 * not a security boundary.
 */
export const IMAGE_CONTENT_TYPES = [
  'image/png',
  'image/jpeg',
  'image/webp',
  'image/gif',
] as const;

export type ImageContentType = (typeof IMAGE_CONTENT_TYPES)[number];

export function isAllowedImageType(ct: string): ct is ImageContentType {
  return (IMAGE_CONTENT_TYPES as readonly string[]).includes(ct);
}

/** Advisory max for avatars/logos surfaced to the client (5 MB). */
export const MAX_IMAGE_BYTES = 5 * 1024 * 1024;
