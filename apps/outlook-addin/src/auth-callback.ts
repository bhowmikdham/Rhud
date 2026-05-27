/**
 * Bridges the Rhud web login flow back to the Outlook task pane.
 *
 * Loaded inside the Office sign-in dialog after rhud.net/login redirects
 * here with the JWT in the URL fragment:
 *   https://addin.rhud.net/auth-callback.html#token=<jwt>&user=<base64-json>
 *
 * The fragment (everything after `#`) never reaches the server — so the
 * token isn't logged in any HTTP access log. The page reads the fragment,
 * calls Office.context.ui.messageParent() to hand the data back to the
 * parent pane, and exits. The parent's DialogMessageReceived handler
 * caches it in localStorage.
 *
 * If anything goes wrong, we still call messageParent so the parent's
 * promise rejects cleanly instead of hanging. The error path is rare in
 * practice — the fragment is set by our own login page, so format
 * mismatches indicate a bug, not adversarial input.
 */

Office.onReady(() => {
  try {
    const frag = new URLSearchParams(window.location.hash.replace(/^#/, ''));
    const token = frag.get('token');
    const userB64 = frag.get('user');
    if (!token || !userB64) {
      throw new Error('Missing token or user in callback fragment');
    }
    // user is base64-encoded JSON so it survives URL encoding without
    // needing escapes for `:` `,` `{` etc.
    const userJson = atob(userB64);
    const user = JSON.parse(userJson);
    Office.context.ui.messageParent(JSON.stringify({ token, user }));
  } catch (e) {
    // Tell the parent why we failed; it will surface via DialogMessageReceived
    // and the JSON.parse there will throw, which is the rejection path
    // we already handle.
    Office.context.ui.messageParent(
      JSON.stringify({ error: (e as Error).message }),
    );
  }
});
