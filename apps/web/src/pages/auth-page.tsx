import type { ErrorKey } from '@/i18n/config';
import { useTranslation } from 'react-i18next';
import { useState, type FormEvent } from 'react';
import { Link, useNavigate } from 'react-router';
import {
  ArrowRight,
  Eye,
  EyeOff,
  LoaderCircle,
  ShieldCheck,
} from 'lucide-react';
import { authClient } from '@/lib/auth-client';
import { authErrorKey, validateCredentials } from '@/lib/auth-errors';
import { useAuthSession } from '@/lib/session-context';
import { Brand } from '@/components/brand';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
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
  const [username, setUsername] = useState('');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [confirmPassword, setConfirmPassword] = useState('');
  const [showPassword, setShowPassword] = useState(false);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<ErrorKey | null>(null);
  const [accountCreated, setAccountCreated] = useState(false);

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (pending || accountCreated) return;
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
      navigate('/', { replace: true });
    } catch (cause) {
      if (created) setAccountCreated(true);
      setError(authErrorKey(cause, 'errors.request'));
    } finally {
      setPending(false);
    }
  }

  return (
    <main className="auth-grid relative flex min-h-dvh flex-col">
      <header className="flex items-center justify-between gap-4 px-6 py-6 sm:px-10">
        <Brand />
        <span className="hidden rounded-full border bg-card/70 px-3 py-1 text-xs text-muted-foreground sm:inline-flex">
          {t('auth.tagline')}
        </span>
      </header>
      <div className="flex flex-1 items-center justify-center px-4 py-8 sm:py-12">
        <div className="w-full max-w-[420px]">
          <div className="mb-7 text-center">
            <p className="mb-3 text-[11px] font-semibold tracking-[0.24em] text-primary">
              {t('auth.eyebrow')}
            </p>
            <h1 className="text-3xl font-semibold tracking-tight sm:text-[34px]">
              {registering ? t('auth.registerHeading') : t('auth.loginHeading')}
            </h1>
            <p className="mt-3 text-sm text-muted-foreground">
              {registering
                ? t('auth.registerDescription')
                : t('auth.loginDescription')}
            </p>
          </div>
          <Card className="shadow-[0_12px_48px_-24px_#253d3440]">
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
                    <div className="relative">
                      <Input
                        id="password"
                        name="password"
                        type={showPassword ? 'text' : 'password'}
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
                        className="pr-11"
                      />
                      <Button
                        variant="ghost"
                        size="icon"
                        className="absolute top-0.5 right-0.5"
                        onClick={() => setShowPassword(!showPassword)}
                        aria-label={
                          showPassword
                            ? t('auth.hidePassword')
                            : t('auth.showPassword')
                        }
                        aria-pressed={showPassword}
                      >
                        {showPassword ? <EyeOff /> : <Eye />}
                      </Button>
                    </div>
                  </div>
                  {registering && (
                    <div className="space-y-2">
                      <Label htmlFor="confirm-password">
                        {t('auth.confirmPassword')}
                      </Label>
                      <Input
                        id="confirm-password"
                        name="confirmPassword"
                        type={showPassword ? 'text' : 'password'}
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
                        {registering ? t('auth.creating') : t('auth.signingIn')}
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
              <p className="mt-6 text-center text-sm text-muted-foreground">
                {registering ? t('auth.hasAccount') : t('auth.noAccount')}{' '}
                <Link
                  to={registering ? '/login' : '/register'}
                  className="rounded-sm font-medium text-primary underline-offset-4 hover:underline focus-visible:outline-2 focus-visible:outline-ring"
                >
                  {registering ? t('auth.goToLogin') : t('auth.register')}
                </Link>
              </p>
            </CardContent>
          </Card>
          <p className="mt-6 flex items-center justify-center gap-1.5 text-xs text-muted-foreground">
            <ShieldCheck className="size-3.5" />
            {t('auth.privacy')}
          </p>
        </div>
      </div>
      <footer className="px-6 pb-6 text-center text-xs text-muted-foreground/80">
        {t('auth.footer')}
      </footer>
    </main>
  );
}
