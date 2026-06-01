// Office.js helpers — reading the open message + the sign-in dialog.

import type { CachedAuth, MessageContext } from './types';

const ADDIN_ORIGIN = import.meta.env.VITE_ADDIN_ORIGIN ?? 'https://addin.rhud.net';

/**
 * Resolve once Office host is ready and we have a Message in read mode.
 * Rejects if Office never initialises (e.g. the host script failed to load)
 * so the pane can show a recoverable error instead of hanging forever.
 */
export function awaitMessageItem(): Promise<Office.MessageRead | null> {
  const ready = new Promise<Office.MessageRead | null>((resolve) => {
    Office.onReady((info) => {
      if (info.host !== Office.HostType.Outlook) return resolve(null);
      const item = Office.context.mailbox.item;
      if (!item || item.itemType !== Office.MailboxEnums.ItemType.Message) {
        return resolve(null);
      }
      resolve(item as Office.MessageRead);
    });
  });
  let timer: ReturnType<typeof setTimeout>;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error('Office failed to initialise')), 10_000);
  });
  // Clear the timer once either branch settles so a stray 10s timer doesn't
  // linger (and reject into the void) on the success path.
  return Promise.race([ready, timeout]).finally(() => clearTimeout(timer));
}

function readBody(item: Office.MessageRead, type: Office.CoercionType): Promise<string> {
  return new Promise((resolve, reject) => {
    item.body.getAsync(type, (r) => {
      if (r.status === Office.AsyncResultStatus.Succeeded) resolve(r.value);
      else reject(new Error(r.error.message));
    });
  });
}

/** Pull subject / from / both body representations off the open message. */
export async function readMessage(item: Office.MessageRead): Promise<MessageContext> {
  const [text, html] = await Promise.all([
    readBody(item, Office.CoercionType.Text),
    readBody(item, Office.CoercionType.Html),
  ]);

  // internetMessageId is the RFC822 Message-Id ("<abc@host>"). Fall back to
  // a synthetic id (rare — drafts before send) so retries within a session
  // still dedupe server-side.
  const messageId =
    item.internetMessageId ??
    `synthetic-${item.from?.emailAddress ?? ''}-${item.subject ?? ''}-${Date.now()}`;

  const dateLabel = item.dateTimeCreated
    ? new Date(item.dateTimeCreated).toLocaleDateString(undefined, { month: 'short', day: 'numeric' })
    : '';

  return {
    subject: item.subject ?? '',
    fromEmail: item.from?.emailAddress ?? '',
    fromName: item.from?.displayName ?? '',
    bodyText: text,
    bodyHtml: html,
    messageId,
    dateLabel,
  };
}

/**
 * Open the Rhud sign-in dialog (same-origin via the Caddy proxy at
 * addin.rhud.net/login) and resolve with the JWT the callback page passes
 * back through messageParent. Must be called from a user gesture — browsers
 * block dialogs/popups that aren't.
 */
export function openSignInDialog(): Promise<CachedAuth> {
  return new Promise((resolve, reject) => {
    Office.context.ui.displayDialogAsync(
      `${ADDIN_ORIGIN}/login?return=addin`,
      { height: 60, width: 30, promptBeforeOpen: false },
      (open) => {
        if (open.status !== Office.AsyncResultStatus.Succeeded) {
          reject(new Error(open.error.message));
          return;
        }
        const dialog = open.value;
        dialog.addEventHandler(Office.EventType.DialogMessageReceived, (arg) => {
          try {
            const payload = JSON.parse((arg as { message: string }).message) as CachedAuth;
            if (!payload.token || !payload.user) throw new Error('Malformed auth payload');
            dialog.close();
            resolve(payload);
          } catch (e) {
            dialog.close();
            reject(e as Error);
          }
        });
        dialog.addEventHandler(Office.EventType.DialogEventReceived, (arg) => {
          // 12006 = user closed the dialog manually.
          if ((arg as { error: number }).error === 12006) reject(new Error('Sign-in cancelled'));
        });
      },
    );
  });
}
