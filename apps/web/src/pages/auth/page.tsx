import type { ErrorKey } from '@/i18n/config';
import { useTranslation } from 'react-i18next';
import { useState, type FormEvent } from 'react';
import { Link, useNavigate } from '@tanstack/react-router';
import {
  ArrowRight,
  FolderOpen,
  MessageSquare,
  Clock3,
  LoaderCircle,
  ShieldCheck,
} from 'lucide-react';
import { authClient } from '@/features/auth/client';
import { authErrorKey, validateCredentials } from '@/features/auth/errors';
import { useAuthSession } from '@/features/auth/session-context';
import { useRegistrationStatus } from '@/features/auth/use-registration-status';
import { Brand } from '@/components/brand';
import { ThemeToggle } from '@/components/theme/theme-toggle';
import { Button } from '@/components/ui/button';
import { PasswordInput } from '@/components/password-input';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { LoadingState } from '@/components/loading-state';
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from '@/components/ui/card';

export function AuthPage({ mode }: { mode: 'login' | 'register' }) {
  const { t } = useTranslation();
  const registering = mode === 'register';
  const navigate = useNavigate();
  const { refetch } = useAuthSession();
  const {
    registrationEnabled,
    error: registrationStatusError,
    retry: retryRegistrationStatus,
  } = useRegistrationStatus();
  const [username, setUsername] = useState('');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [confirmPassword, setConfirmPassword] = useState('');
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<ErrorKey | null>(null);
  const [accountCreated, setAccountCreated] = useState(false);

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (pending || accountCreated) return;
    if (registering && registrationEnabled !== true) return;
    setError(null);
    const normalizedUsername = username.trim();
    const validation = validateCredentials(normalizedUsername, password);
    if (validation) {
      setError(validation);
      return;
    }
    const emailInput = event.currentTarget.elements.namedItem('email');
    if (
      registering &&
      emailInput instanceof HTMLInputElement &&
      !emailInput.validity.valid
    ) {
      setError('errors.email');
      return;
    }
    if (registering && password !== confirmPassword) {
      setError('errors.passwordMismatch');
      return;
    }
    setPending(true);
    let created = false;
    try {
      if (registering) {
        const result = await authClient.signUp.email({
          username: normalizedUsername,
          name: normalizedUsername,
          email: email.trim(),
          password,
        });
        if (result.error) {
          setError(authErrorKey(result.error, 'errors.signUp'));
          if (result.error.code === 'SIGNUP_DISABLED')
            retryRegistrationStatus();
          return;
        }
        created = true;
        // Better Auth normally creates a session on sign-up. Sign in if the server did not issue one.
        if (!result.data?.token) {
          const login = await authClient.signIn.username({
            username: normalizedUsername,
            password,
          });
          if (login.error) {
            setAccountCreated(true);
            setError(authErrorKey(login.error, 'errors.goToLogin'));
            return;
          }
        }
      } else {
        const result = await authClient.signIn.username({
          username: normalizedUsername,
          password,
        });
        if (result.error) {
          setError(authErrorKey(result.error, 'errors.signIn'));
          return;
        }
      }
      await refetch();
      void navigate({ to: '/', replace: true });
    } catch (cause) {
      if (created) setAccountCreated(true);
      setError(authErrorKey(cause, 'errors.request'));
    } finally {
      setPending(false);
    }
  }

  return (
    <main className="relative flex min-h-dvh flex-col">
      <header className="flex items-center justify-between gap-4 px-6 py-6 sm:px-10">
        <Link
          to="/home"
          aria-label={t('home.title')}
          className="rounded-lg outline-none focus-visible:ring-2 focus-visible:ring-ring"
        >
          <Brand />
        </Link>
        <div className="flex shrink-0 items-center gap-3">
          <span className="hidden rounded-full border bg-card/70 px-3 py-1 text-xs text-muted-foreground sm:inline-flex">
            {t('auth.tagline')}
          </span>
          <ThemeToggle />
        </div>
      </header>
      <div className="mx-auto grid w-full max-w-6xl flex-1 items-center gap-14 px-5 py-8 sm:px-10 sm:py-12 lg:grid-cols-[1.1fr_1fr]">
        <section
          className="hidden self-stretch rounded-2xl bg-[var(--feature-surface)] p-10 text-white lg:flex lg:flex-col lg:justify-between"
          aria-labelledby="auth-product-title"
        >
          <div>
            <span className="text-sm text-white/75">{t('auth.tagline')}</span>
            <h2
              id="auth-product-title"
              className="mt-7 max-w-sm text-4xl leading-snug font-semibold"
            >
              {t('auth.productTitle')}
            </h2>
            <p className="mt-5 max-w-sm text-sm leading-7 text-white/80">
              {t('auth.productDescription')}
            </p>
          </div>
          <ul className="mt-12 space-y-5 border-t border-white/20 pt-7">
            <li className="flex items-center gap-3 text-sm text-white/90">
              <MessageSquare className="size-4" aria-hidden />
              {t('workspace.focusChat')}
            </li>
            <li className="flex items-center gap-3 text-sm text-white/90">
              <FolderOpen className="size-4" aria-hidden />
              {t('workspace.focusProjects')}
            </li>
            <li className="flex items-center gap-3 text-sm text-white/90">
              <Clock3 className="size-4" aria-hidden />
              {t('workspace.focusAutomations')}
            </li>
          </ul>
        </section>
        <div className="mx-auto w-full max-w-[420px]">
          <div className="mb-7 text-center">
            <h1 className="text-3xl font-semibold tracking-tight sm:text-[34px]">
              {registering ? t('auth.registerHeading') : t('auth.loginHeading')}
            </h1>
            <p className="mt-3 text-sm text-muted-foreground">
              {registering
                ? t('auth.registerDescription')
                : t('auth.loginDescription')}
            </p>
          </div>
          <Card>
            <CardHeader className="px-6 pt-7 sm:px-8">
              <CardTitle className="text-lg">
                {registering ? t('auth.createAccount') : t('auth.login')}
              </CardTitle>
              <CardDescription>
                {registering
                  ? t('auth.registerInstructions')
                  : t('auth.loginInstructions')}
              </CardDescription>
            </CardHeader>
            <CardContent className="px-6 pb-7 sm:px-8">
              {registering && registrationEnabled !== true ? (
                registrationStatusError ? (
                  <div role="alert" className="space-y-4">
                    <p className="text-sm text-destructive">
                      {t('errors.request')}
                    </p>
                    <Button variant="outline" onClick={retryRegistrationStatus}>
                      {t('settings.retry')}
                    </Button>
                  </div>
                ) : registrationEnabled === false ? (
                  <p
                    role="status"
                    className="rounded-lg border bg-muted/40 px-4 py-3 text-sm leading-6 text-muted-foreground"
                  >
                    {t('errors.signUpDisabled')}
                  </p>
                ) : (
                  <LoadingState />
                )
              ) : (
                <form
                  noValidate
                  onSubmit={(event) => void submit(event)}
                  className="space-y-5"
                  aria-busy={pending}
                  aria-describedby={error ? 'auth-error' : undefined}
                >
                  <fieldset
                    disabled={pending || accountCreated}
                    className="min-w-0 space-y-5"
                  >
                    <div className="space-y-2">
                      <Label htmlFor="username">{t('auth.username')}</Label>
                      <Input
                        id="username"
                        name="username"
                        autoComplete="username"
                        autoCapitalize="none"
                        spellCheck={false}
                        required
                        minLength={3}
                        maxLength={30}
                        pattern="[a-zA-Z0-9_.]+"
                        title={t('auth.usernameTitle')}
                        placeholder={t('auth.usernamePlaceholder')}
                        value={username}
                        onChange={(event) => setUsername(event.target.value)}
                        aria-describedby={
                          registering ? 'username-hint' : undefined
                        }
                      />
                      {registering && (
                        <p
                          id="username-hint"
                          className="text-xs leading-5 text-muted-foreground"
                        >
                          {t('auth.usernameHint')}
                        </p>
                      )}
                    </div>
                    {registering && (
                      <div className="space-y-2">
                        <Label htmlFor="email">{t('auth.email')}</Label>
                        <Input
                          id="email"
                          name="email"
                          type="email"
                          autoComplete="email"
                          autoCapitalize="none"
                          required
                          placeholder="you@example.com"
                          value={email}
                          onChange={(event) => setEmail(event.target.value)}
                        />
                      </div>
                    )}
                    <div className="space-y-2">
                      <Label htmlFor="password">{t('auth.password')}</Label>
                      <PasswordInput
                        id="password"
                        name="password"
                        autoComplete={
                          registering ? 'new-password' : 'current-password'
                        }
                        required
                        minLength={8}
                        maxLength={128}
                        placeholder={
                          registering
                            ? t('auth.newPasswordPlaceholder')
                            : t('auth.passwordPlaceholder')
                        }
                        value={password}
                        onChange={(event) => setPassword(event.target.value)}
                      />
                    </div>
                    {registering && (
                      <div className="space-y-2">
                        <Label htmlFor="confirm-password">
                          {t('auth.confirmPassword')}
                        </Label>
                        <PasswordInput
                          id="confirm-password"
                          name="confirmPassword"
                          autoComplete="new-password"
                          required
                          minLength={8}
                          maxLength={128}
                          placeholder={t('auth.confirmPasswordPlaceholder')}
                          value={confirmPassword}
                          onChange={(event) =>
                            setConfirmPassword(event.target.value)
                          }
                        />
                      </div>
                    )}
                  </fieldset>
                  {error && (
                    <p
                      id="auth-error"
                      role="alert"
                      className="rounded-lg border border-destructive/20 bg-destructive/5 px-3 py-2.5 text-sm leading-6 text-destructive"
                    >
                      {accountCreated
                        ? t('auth.createdError', { message: t(error) })
                        : t(error)}
                    </p>
                  )}
                  {accountCreated ? (
                    <Button asChild className="h-11 w-full">
                      <Link to="/login">
                        {t('auth.goToLogin')}
                        <ArrowRight />
                      </Link>
                    </Button>
                  ) : (
                    <Button
                      type="submit"
                      disabled={pending}
                      className="h-11 w-full"
                    >
                      {pending ? (
                        <>
                          <LoaderCircle className="animate-spin" />
                          {registering
                            ? t('auth.creating')
                            : t('auth.signingIn')}
                        </>
                      ) : (
                        <>
                          {registering
                            ? t('auth.createAccount')
                            : t('auth.submitLogin')}
                          <ArrowRight />
                        </>
                      )}
                    </Button>
                  )}
                </form>
              )}
              {registering || registrationEnabled === true ? (
                <p className="mt-6 text-center text-sm text-muted-foreground">
                  {registering ? t('auth.hasAccount') : t('auth.noAccount')}{' '}
                  <Link
                    to={registering ? '/login' : '/register'}
                    className="rounded-sm font-medium text-primary underline-offset-4 hover:underline focus-visible:outline-2 focus-visible:outline-ring"
                  >
                    {registering ? t('auth.goToLogin') : t('auth.register')}
                  </Link>
                </p>
              ) : registrationEnabled === false ? (
                <p className="mt-6 text-center text-sm text-muted-foreground">
                  {t('errors.signUpDisabled')}
                </p>
              ) : null}
            </CardContent>
          </Card>
          <p className="mt-6 flex items-center justify-center gap-1.5 text-xs text-muted-foreground">
            <ShieldCheck className="size-3.5" />
            {t('auth.privacy')}
          </p>
        </div>
      </div>
      {/* <footer className="px-6 pb-6 text-center text-xs text-muted-foreground">
        {t('auth.footer')}
      </footer> */}
    </main>
  );
}
