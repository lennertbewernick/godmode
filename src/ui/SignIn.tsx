/**
 * The gate: sign in to an existing account, or create one, or continue with Google.
 *
 * Everything behind the app requires an authenticated session (`App.tsx`), and this is where one
 * is obtained. It replaced the single shared-token screen when the app grew real per-user accounts
 * (LBV-1480). Three ways in, in order of how most people will use them:
 *
 *   - **Continue with Google** — a top-level navigation to `/auth/google/login`, shown only when
 *     the server reports a configured OAuth client (`googleEnabled`). Not a `fetch`: the browser
 *     leaves for Google and returns to a callback the server handles.
 *   - **Email + password** — a same-origin POST that mints the `HttpOnly` session cookie. The
 *     password lives only in this component's state and is dropped the moment it is exchanged;
 *     nothing writes it to `localStorage`, a URL, or a log.
 *   - **Create an account** — the same, against `/api/register`, plus an invite code when the
 *     server is invite-gated (`registrationMode === 'invite'`).
 *
 * `type="password"`/`autoComplete` are set so a password manager can hold the credentials and the
 * owner is not retyping on a phone; `spellCheck`/autocapitalisation are off so iOS does not
 * "correct" an email or a code.
 */

import { useState } from 'react';
import { ApiError, googleLoginUrl, login, register, type RegistrationMode } from '../api/client.js';
import { Banner, Button, Card } from './kit.js';

type Mode = 'login' | 'register';

export function SignIn({
  onSignedIn,
  reason,
  googleEnabled,
  registrationMode,
}: {
  onSignedIn: () => void;
  /** Why the user is here, when they did not come here on purpose. */
  reason?: string | undefined;
  googleEnabled: boolean;
  registrationMode: RegistrationMode;
}) {
  const [mode, setMode] = useState<Mode>('login');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [invite, setInvite] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const registering = mode === 'register';
  const needsInvite = registering && registrationMode === 'invite';
  const registrationClosed = registering && registrationMode === 'closed';

  async function submit(): Promise<void> {
    if (busy || email.trim() === '' || password === '') return;
    setBusy(true);
    setError(null);
    try {
      if (registering) {
        await register({
          email: email.trim(),
          password,
          ...(invite.trim() === '' ? {} : { inviteCode: invite.trim() }),
        });
      } else {
        await login({ email: email.trim(), password });
      }
      // Dropped from state the moment they have been exchanged.
      setPassword('');
      setInvite('');
      onSignedIn();
    } catch (cause) {
      setError(
        cause instanceof ApiError
          ? cause.kind === 'unreachable'
            ? 'The server is not answering. Try again in a moment.'
            : cause.message
          : registering
            ? 'Could not create the account.'
            : 'Sign-in failed.',
      );
      setBusy(false);
    }
  }

  function continueWithGoogle(): void {
    // A top-level navigation, carrying the invite code the user typed (if any) so a new Google
    // account can pass an invite gate. Never a fetch — the browser leaves for Google.
    window.location.assign(googleLoginUrl(needsInvite ? invite : undefined));
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
        <h2 className="text-lg font-semibold text-slate-100">
          {registering ? 'Create your account' : 'Sign in'}
        </h2>
        <p className="mt-1.5 text-sm leading-relaxed text-slate-300">
          Your training lives on this server, in your own account.
        </p>

        {googleEnabled ? (
          <div className="mt-4">
            <Button className="w-full" variant="ghost" onClick={continueWithGoogle}>
              Continue with Google
            </Button>
            <div className="my-4 flex items-center gap-3 text-xs uppercase tracking-wider text-slate-500">
              <span className="h-px flex-1 bg-[#33405c]" />
              or
              <span className="h-px flex-1 bg-[#33405c]" />
            </div>
          </div>
        ) : null}

        <form
          className="mt-4 flex flex-col gap-3"
          onSubmit={(e) => {
            e.preventDefault();
            void submit();
          }}
        >
          <label className="block">
            <span className="text-sm font-medium text-slate-300">Email</span>
            <input
              type="email"
              value={email}
              autoComplete="username"
              autoCapitalize="off"
              autoCorrect="off"
              spellCheck={false}
              onChange={(e) => setEmail(e.target.value)}
              className="mt-1.5 block min-h-11 w-full rounded-xl border border-[#33405c] bg-[#0f1728] px-3 py-2 text-sm text-slate-100 outline-none focus:border-teal-400/60"
            />
          </label>

          <label className="block">
            <span className="text-sm font-medium text-slate-300">Password</span>
            <input
              type="password"
              value={password}
              autoComplete={registering ? 'new-password' : 'current-password'}
              autoCapitalize="off"
              autoCorrect="off"
              spellCheck={false}
              onChange={(e) => setPassword(e.target.value)}
              className="mt-1.5 block min-h-11 w-full rounded-xl border border-[#33405c] bg-[#0f1728] px-3 py-2 text-sm text-slate-100 outline-none focus:border-teal-400/60"
            />
          </label>

          {needsInvite ? (
            <label className="block">
              <span className="text-sm font-medium text-slate-300">Invite code</span>
              <input
                type="text"
                value={invite}
                autoCapitalize="off"
                autoCorrect="off"
                spellCheck={false}
                onChange={(e) => setInvite(e.target.value)}
                className="mt-1.5 block min-h-11 w-full rounded-xl border border-[#33405c] bg-[#0f1728] px-3 py-2 text-sm text-slate-100 outline-none focus:border-teal-400/60"
              />
              <span className="mt-1 block text-xs text-slate-500">
                This server is invite-only. Ask the owner for a code.
              </span>
            </label>
          ) : null}

          {error ? <Banner tone="warn">{error}</Banner> : null}
          {registrationClosed ? (
            <Banner tone="info">This server is not accepting new accounts right now.</Banner>
          ) : null}

          <Button
            className="w-full"
            type="submit"
            disabled={busy || email.trim() === '' || password === '' || registrationClosed}
            onClick={() => void submit()}
          >
            {busy
              ? registering
                ? 'Creating…'
                : 'Signing in…'
              : registering
                ? 'Create account'
                : 'Sign in'}
          </Button>
        </form>

        <p className="mt-4 text-sm text-slate-400">
          {registering ? 'Already have an account?' : 'No account yet?'}{' '}
          <button
            type="button"
            className="font-medium text-teal-300 underline underline-offset-2"
            onClick={() => {
              setMode(registering ? 'login' : 'register');
              setError(null);
            }}
          >
            {registering ? 'Sign in' : 'Create one'}
          </button>
        </p>
      </Card>

      <p className="mt-4 px-1 text-xs leading-relaxed text-slate-500">
        Your session is a cookie the browser keeps and JavaScript cannot read. Your password is
        never stored on this device and never appears in a backup, a CSV or a share card.
      </p>
    </div>
  );
}
