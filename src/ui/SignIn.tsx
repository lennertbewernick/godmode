/**
 * The one place the shared token is ever typed.
 *
 * It goes straight to `POST /api/session` and is exchanged for an `HttpOnly` cookie script
 * cannot read (`.planning/DESIGN-server-sqlite.md` §9). Nothing here writes it to
 * `localStorage`, puts it in a URL, or logs it — the only reference to the string is this
 * component's own state, which dies with the screen.
 *
 * `type="password"` and `autoComplete="current-password"` so a password manager can hold it and
 * the owner is not retyping 64 hex characters on a phone. `spellCheck` and autocapitalisation
 * off, because iOS will otherwise "correct" a secret.
 */

import { useState } from 'react';
import { ApiError, openSession } from '../api/client.js';
import { Banner, Button, Card } from './kit.js';

export function SignIn({
  onSignedIn,
  reason,
}: {
  onSignedIn: () => void;
  /** Why the user is here, when they did not come here on purpose. */
  reason?: string | undefined;
}) {
  const [token, setToken] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function submit(): Promise<void> {
    if (token.trim() === '' || busy) return;
    setBusy(true);
    setError(null);
    try {
      await openSession(token);
      // Dropped from state the moment it has been exchanged.
      setToken('');
      onSignedIn();
    } catch (cause) {
      setError(
        cause instanceof ApiError
          ? cause.kind === 'unreachable'
            ? 'The server is not answering. Start it, then try again.'
            : cause.message
          : 'Sign-in failed.',
      );
      setBusy(false);
    }
  }

  return (
    <div className="mx-auto w-full px-4 pb-10 md:max-w-md safe-t">
      <header className="py-8">
        <h1 className="text-3xl font-bold tracking-tight text-slate-100">GODMODE</h1>
        <p className="mt-1 text-sm uppercase tracking-[0.2em] text-teal-300">No More Later</p>
      </header>

      {reason ? (
        <div className="pb-4">
          <Banner tone="warn">{reason}</Banner>
        </div>
      ) : null}

      <Card>
        <h2 className="text-lg font-semibold text-slate-100">Sign in</h2>
        <p className="mt-1.5 text-sm leading-relaxed text-slate-300">
          Your training lives on your own server. Paste the token it printed — run{' '}
          <code className="rounded bg-[#0f1728] px-1 py-0.5 text-xs">npm run token</code> to see
          it again.
        </p>

        <form
          className="mt-4 flex flex-col gap-3"
          onSubmit={(e) => {
            e.preventDefault();
            void submit();
          }}
        >
          <label className="block">
            <span className="text-sm font-medium text-slate-300">Token</span>
            <input
              type="password"
              value={token}
              autoComplete="current-password"
              autoCapitalize="off"
              autoCorrect="off"
              spellCheck={false}
              onChange={(e) => setToken(e.target.value)}
              className="tnum mt-1.5 block min-h-11 w-full rounded-xl border border-[#33405c] bg-[#0f1728] px-3 py-2 text-sm text-slate-100 outline-none focus:border-teal-400/60"
            />
          </label>

          {error ? <Banner tone="warn">{error}</Banner> : null}

          <Button className="w-full" disabled={busy || token.trim() === ''} onClick={() => void submit()}>
            {busy ? 'Signing in…' : 'Sign in'}
          </Button>
        </form>
      </Card>

      <p className="mt-4 px-1 text-xs leading-relaxed text-slate-500">
        The token is exchanged for a session cookie the browser keeps and JavaScript cannot read.
        It never appears in a backup, a CSV or a share card.
      </p>
    </div>
  );
}
