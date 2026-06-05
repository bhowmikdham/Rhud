/**
 * Unit tests for S3Service.deleteByPrefix — the storage-reclaim sweep that
 * runs when a profile photo / workspace logo is replaced or removed.
 *
 * The rest of the codebase tests against real backends, but this method's
 * value is in its orchestration (page through ListObjectsV2, drop the
 * key we're keeping, batch-delete the rest, swallow any failure), which we
 * can pin down deterministically by injecting a fake S3 client. A real-MinIO
 * round-trip still happens via the app in dev; this guards the branching.
 */

import { describe, it, expect, vi } from 'vitest';
import {
  ListObjectsV2Command,
  DeleteObjectsCommand,
} from '@aws-sdk/client-s3';
import { S3Service } from './s3.service.js';

type Send = ReturnType<typeof vi.fn>;

/** Build an S3Service with its private client swapped for `fakeSend`. */
function withFakeClient(fakeSend: (cmd: unknown) => Promise<unknown>): {
  svc: S3Service;
  send: Send;
} {
  const svc = new S3Service();
  const send = vi.fn(fakeSend);
  (svc as unknown as { client: { send: Send } }).client = { send };
  return { svc, send };
}

const listCmds = (send: Send): ListObjectsV2Command[] =>
  send.mock.calls
    .map((c) => c[0])
    .filter((c): c is ListObjectsV2Command => c instanceof ListObjectsV2Command);
const deleteCmds = (send: Send): DeleteObjectsCommand[] =>
  send.mock.calls
    .map((c) => c[0])
    .filter((c): c is DeleteObjectsCommand => c instanceof DeleteObjectsCommand);

describe('S3Service.deleteByPrefix', () => {
  it('deletes every object under the prefix except the kept key', async () => {
    const { svc, send } = withFakeClient(async (cmd) => {
      if (cmd instanceof ListObjectsV2Command) {
        return {
          Contents: [{ Key: 'avatars/t/u/a/x.png' }, { Key: 'avatars/t/u/b/y.png' }, { Key: 'avatars/t/u/c/z.png' }],
          IsTruncated: false,
        };
      }
      return {};
    });

    await svc.deleteByPrefix('avatars/t/u/', { keep: 'avatars/t/u/b/y.png' });

    const dels = deleteCmds(send);
    expect(dels).toHaveLength(1);
    // The kept key is excluded; the other two are deleted in one batch.
    expect(dels[0]!.input.Delete?.Objects).toEqual([
      { Key: 'avatars/t/u/a/x.png' },
      { Key: 'avatars/t/u/c/z.png' },
    ]);
    const lists = listCmds(send);
    expect(lists[0]!.input.Prefix).toBe('avatars/t/u/');
  });

  it('removes everything when no key is kept (avatar/logo cleared)', async () => {
    const { svc, send } = withFakeClient(async (cmd) => {
      if (cmd instanceof ListObjectsV2Command) {
        return { Contents: [{ Key: 'branding/t/a/logo.png' }], IsTruncated: false };
      }
      return {};
    });

    await svc.deleteByPrefix('branding/t/');

    const dels = deleteCmds(send);
    expect(dels).toHaveLength(1);
    expect(dels[0]!.input.Delete?.Objects).toEqual([{ Key: 'branding/t/a/logo.png' }]);
  });

  it('pages through a truncated listing, threading the continuation token', async () => {
    const { svc, send } = withFakeClient(async (cmd) => {
      if (cmd instanceof ListObjectsV2Command) {
        const token = cmd.input.ContinuationToken;
        if (!token) {
          return { Contents: [{ Key: 'p/a' }], IsTruncated: true, NextContinuationToken: 'tok-2' };
        }
        return { Contents: [{ Key: 'p/b' }], IsTruncated: false };
      }
      return {};
    });

    await svc.deleteByPrefix('p/');

    const lists = listCmds(send);
    expect(lists).toHaveLength(2);
    expect(lists[0]!.input.ContinuationToken).toBeUndefined();
    expect(lists[1]!.input.ContinuationToken).toBe('tok-2');
    // One delete per page, both objects swept.
    const deleted = deleteCmds(send).flatMap((d) => d.input.Delete?.Objects ?? []);
    expect(deleted).toEqual([{ Key: 'p/a' }, { Key: 'p/b' }]);
  });

  it('issues no delete when only the kept key is present', async () => {
    const { svc, send } = withFakeClient(async (cmd) => {
      if (cmd instanceof ListObjectsV2Command) {
        return { Contents: [{ Key: 'p/keep' }], IsTruncated: false };
      }
      return {};
    });

    await svc.deleteByPrefix('p/', { keep: 'p/keep' });

    expect(deleteCmds(send)).toHaveLength(0);
  });

  it('swallows backend failures (best-effort — never throws)', async () => {
    const { svc } = withFakeClient(async () => {
      throw new Error('minio unreachable');
    });

    await expect(svc.deleteByPrefix('p/')).resolves.toBeUndefined();
  });
});
