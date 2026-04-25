import { Injectable, Logger } from '@nestjs/common';

/**
 * Email transport interface — the abstraction every transport implements.
 * Sprint 4 ships a console transport (dev-friendly: prints to logs and
 * keeps a per-process buffer the smoke test can introspect) and a stub
 * Postmark transport that lights up once the user supplies a server token.
 *
 * Contract:
 *   - `send` is best-effort fire-and-forget from the caller's perspective;
 *     errors are logged but do not propagate. Notification dispatch must
 *     never block thread-event creation.
 *   - Transports MUST be idempotent on the (toEmail, subject, hash(body))
 *     triple if they're at-least-once. Sprint 4's transports don't dedupe
 *     yet — when we move to BullMQ retries, we'll add a dedup key.
 */
export interface SendArgs {
  to: string;
  subject: string;
  textBody: string;
  /** Stable correlation id; helps trace a fan-out across logs. */
  notificationId: string;
}

export abstract class EmailTransport {
  abstract send(args: SendArgs): Promise<void>;
}

/**
 * Console transport — logs every email + keeps an in-memory buffer.
 *
 * The buffer is bounded (last 200) and exposed via getRecent() so the
 * smoke test (and later, an admin "outbox" view) can verify fan-out
 * without standing up a real SMTP catcher.
 */
@Injectable()
export class ConsoleEmailTransport extends EmailTransport {
  private readonly logger = new Logger(ConsoleEmailTransport.name);
  private static readonly BUFFER_SIZE = 200;
  private readonly buffer: SendArgs[] = [];

  async send(args: SendArgs): Promise<void> {
    this.buffer.push(args);
    if (this.buffer.length > ConsoleEmailTransport.BUFFER_SIZE) {
      this.buffer.shift();
    }
    this.logger.log(
      `[email/console] to=${args.to} subj="${args.subject}" id=${args.notificationId}`,
    );
  }

  getRecent(): SendArgs[] {
    return [...this.buffer];
  }

  clear(): void {
    this.buffer.length = 0;
  }
}

/**
 * Postmark transport — production-bound; leaves an explicit hole until the
 * customer confirms their Postmark server token (design doc §5 open
 * question on email provider). For now the constructor warns and `send`
 * throws so a misconfigured prod environment fails loudly rather than
 * silently dropping mail.
 */
@Injectable()
export class PostmarkEmailTransport extends EmailTransport {
  private readonly logger = new Logger(PostmarkEmailTransport.name);
  private readonly serverToken: string | undefined;

  constructor() {
    super();
    this.serverToken = process.env.POSTMARK_SERVER_TOKEN;
    if (!this.serverToken) {
      this.logger.warn(
        'POSTMARK_SERVER_TOKEN unset — Postmark transport will throw on send. ' +
          'Set the env or fall back to ConsoleEmailTransport for dev.',
      );
    }
  }

  async send(args: SendArgs): Promise<void> {
    if (!this.serverToken) {
      throw new Error('postmark_not_configured');
    }
    // Real implementation goes here once the customer's Postmark account
    // is set up. Intentionally not pulling in the postmark npm package
    // until then — keeps the dependency tree honest about what's wired.
    void args;
    throw new Error('postmark_send_not_implemented');
  }
}

/**
 * Factory: pick the transport based on env. Default = console.
 */
export function chooseEmailTransport(): EmailTransport {
  const provider = process.env.EMAIL_PROVIDER ?? 'console';
  switch (provider) {
    case 'postmark':
      return new PostmarkEmailTransport();
    case 'console':
    default:
      return new ConsoleEmailTransport();
  }
}
