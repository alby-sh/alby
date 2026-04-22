import { useEffect, useState } from 'react'
import { useAuthStore } from '../../stores/auth-store'

function AlbyLogo({ size = 48 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 32 32" fill="none" aria-hidden>
      <defs>
        <linearGradient id="alby-login-g" x1="0" y1="0" x2="32" y2="32">
          <stop offset="0" stopColor="#60a5fa" />
          <stop offset="1" stopColor="#a78bfa" />
        </linearGradient>
      </defs>
      <rect x="1" y="1" width="30" height="30" rx="8" fill="#0a0a0a" stroke="url(#alby-login-g)" strokeWidth="1.5" />
      <path d="M9 22 L13 10 L19 10 L23 22 M11 18 H21" stroke="url(#alby-login-g)" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" fill="none" />
      <circle cx="16" cy="6" r="1.6" fill="url(#alby-login-g)" />
    </svg>
  )
}

function GoogleIcon() {
  return (
    <svg width="18" height="18" viewBox="0 0 48 48" aria-hidden>
      <path fill="#FFC107" d="M43.6 20.5H42V20H24v8h11.3c-1.6 4.6-6 8-11.3 8-6.6 0-12-5.4-12-12s5.4-12 12-12c3 0 5.8 1.1 7.9 3l5.7-5.7C34 6.1 29.3 4 24 4 12.9 4 4 12.9 4 24s8.9 20 20 20 20-8.9 20-20c0-1.3-.1-2.4-.4-3.5z" />
      <path fill="#FF3D00" d="M6.3 14.7l6.6 4.8C14.7 15.1 19 12 24 12c3 0 5.8 1.1 7.9 3l5.7-5.7C34 6.1 29.3 4 24 4 16.3 4 9.6 8.4 6.3 14.7z" />
      <path fill="#4CAF50" d="M24 44c5.2 0 9.9-2 13.5-5.2l-6.2-5.2c-2 1.4-4.5 2.4-7.3 2.4-5.3 0-9.7-3.4-11.3-8L6.1 32.5C9.4 39.3 16.2 44 24 44z" />
      <path fill="#1976D2" d="M43.6 20.5H42V20H24v8h11.3c-.8 2.3-2.3 4.2-4.2 5.6l6.2 5.2C40.7 35.7 44 30.3 44 24c0-1.3-.1-2.4-.4-3.5z" />
    </svg>
  )
}

function MicrosoftIcon() {
  return (
    <svg width="18" height="18" viewBox="0 0 23 23" aria-hidden>
      <path fill="#f25022" d="M1 1h10v10H1z" />
      <path fill="#7fba00" d="M12 1h10v10H12z" />
      <path fill="#00a4ef" d="M1 12h10v10H1z" />
      <path fill="#ffb900" d="M12 12h10v10H12z" />
    </svg>
  )
}

type Mode = 'choose' | 'login-email' | 'register-email' | 'register-otp'

export function LoginScreen() {
  const busy = useAuthStore((s) => s.busy)
  const error = useAuthStore((s) => s.error)
  const clearError = useAuthStore((s) => s.clearError)
  const loginWithProvider = useAuthStore((s) => s.loginWithProvider)
  const loginWithEmail = useAuthStore((s) => s.loginWithEmail)
  const registerWithEmail = useAuthStore((s) => s.registerWithEmail)
  const verifyOtp = useAuthStore((s) => s.verifyOtp)

  const [mode, setMode] = useState<Mode>('choose')
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [name, setName] = useState('')
  const [otp, setOtp] = useState('')

  useEffect(() => { clearError() }, [mode, clearError])

  const onProvider = async (p: 'google' | 'microsoft'): Promise<void> => {
    await loginWithProvider(p)
  }

  const onEmailLogin = async (e: React.FormEvent): Promise<void> => {
    e.preventDefault()
    await loginWithEmail(email.trim(), password)
  }

  const onEmailRegister = async (e: React.FormEvent): Promise<void> => {
    e.preventDefault()
    try {
      await registerWithEmail(email.trim(), password, name.trim())
      setMode('register-otp')
    } catch { /* error already in store */ }
  }

  const onVerifyOtp = async (e: React.FormEvent): Promise<void> => {
    e.preventDefault()
    try {
      await verifyOtp(email.trim(), otp.trim())
    } catch { /* error already in store */ }
  }

  return (
    <div className="absolute inset-0 flex items-center justify-center bg-[var(--bg-primary)] text-neutral-100">
      <div className="w-[400px] p-8 rounded-2xl border border-neutral-900 bg-neutral-950/70 backdrop-blur-sm shadow-2xl">
        <div className="flex flex-col items-center mb-8">
          <AlbyLogo size={48} />
          <h1 className="mt-4 text-xl font-semibold tracking-tight">Welcome to Alby</h1>
          <p className="mt-1 text-[13px] text-neutral-500">
            {mode === 'choose' && 'Sign in or create your account'}
            {mode === 'login-email' && 'Sign in with email'}
            {mode === 'register-email' && 'Create your account'}
            {mode === 'register-otp' && `Enter the 6-digit code sent to ${email}`}
          </p>
        </div>

        {mode === 'choose' && (
          <>
            <div className="space-y-2">
              <button
                type="button"
                onClick={() => onProvider('google')}
                disabled={busy}
                className="flex items-center justify-center gap-2 w-full h-10 rounded-md bg-white text-neutral-900 text-[14px] font-medium hover:bg-neutral-100 disabled:opacity-50"
              >
                <GoogleIcon /> Continue with Google
              </button>
              <button
                type="button"
                onClick={() => onProvider('microsoft')}
                disabled={busy}
                className="flex items-center justify-center gap-2 w-full h-10 rounded-md bg-neutral-900 border border-neutral-800 text-[14px] hover:bg-neutral-800 disabled:opacity-50"
              >
                <MicrosoftIcon /> Continue with Microsoft
              </button>
            </div>

            <div className="my-5 flex items-center gap-3 text-[11px] text-neutral-600">
              <div className="flex-1 h-px bg-neutral-900" />
              <span>or</span>
              <div className="flex-1 h-px bg-neutral-900" />
            </div>

            <div className="space-y-2">
              <button
                type="button"
                onClick={() => setMode('login-email')}
                className="w-full h-10 rounded-md border border-neutral-800 text-[13px] text-neutral-300 hover:bg-neutral-900"
              >
                Sign in with email
              </button>
              <button
                type="button"
                onClick={() => setMode('register-email')}
                className="w-full h-10 rounded-md text-[13px] text-neutral-400 hover:text-neutral-200"
              >
                Create a new account
              </button>
            </div>
          </>
        )}

        {mode === 'login-email' && (
          <form onSubmit={onEmailLogin} className="space-y-3">
            <input
              type="email"
              required
              autoFocus
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              placeholder="you@example.com"
              className="w-full h-10 px-3 rounded-md bg-neutral-900 border border-neutral-800 text-[14px] placeholder:text-neutral-600 focus:outline-none focus:border-neutral-600"
            />
            <input
              type="password"
              required
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              placeholder="Password"
              className="w-full h-10 px-3 rounded-md bg-neutral-900 border border-neutral-800 text-[14px] placeholder:text-neutral-600 focus:outline-none focus:border-neutral-600"
            />
            <button
              type="submit"
              disabled={busy}
              className="w-full h-10 rounded-md bg-neutral-100 text-neutral-950 text-[14px] font-medium hover:bg-white disabled:opacity-50"
            >
              {busy ? 'Signing in…' : 'Sign in'}
            </button>
            <button
              type="button"
              onClick={() => setMode('choose')}
              className="w-full text-[12px] text-neutral-500 hover:text-neutral-300"
            >
              ← Back
            </button>
          </form>
        )}

        {mode === 'register-email' && (
          <form onSubmit={onEmailRegister} className="space-y-3">
            <input
              type="text"
              required
              autoFocus
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="Your name"
              className="w-full h-10 px-3 rounded-md bg-neutral-900 border border-neutral-800 text-[14px] placeholder:text-neutral-600 focus:outline-none focus:border-neutral-600"
            />
            <input
              type="email"
              required
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              placeholder="you@example.com"
              className="w-full h-10 px-3 rounded-md bg-neutral-900 border border-neutral-800 text-[14px] placeholder:text-neutral-600 focus:outline-none focus:border-neutral-600"
            />
            <input
              type="password"
              required
              minLength={8}
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              placeholder="Password (min 8 chars)"
              className="w-full h-10 px-3 rounded-md bg-neutral-900 border border-neutral-800 text-[14px] placeholder:text-neutral-600 focus:outline-none focus:border-neutral-600"
            />
            <button
              type="submit"
              disabled={busy}
              className="w-full h-10 rounded-md bg-neutral-100 text-neutral-950 text-[14px] font-medium hover:bg-white disabled:opacity-50"
            >
              {busy ? 'Sending code…' : 'Send verification code'}
            </button>
            <button
              type="button"
              onClick={() => setMode('choose')}
              className="w-full text-[12px] text-neutral-500 hover:text-neutral-300"
            >
              ← Back
            </button>
          </form>
        )}

        {mode === 'register-otp' && (
          <form onSubmit={onVerifyOtp} className="space-y-3">
            <input
              type="text"
              required
              autoFocus
              maxLength={6}
              inputMode="numeric"
              pattern="[0-9]{6}"
              value={otp}
              onChange={(e) => setOtp(e.target.value)}
              placeholder="123456"
              className="w-full h-12 px-3 rounded-md bg-neutral-900 border border-neutral-800 text-[20px] text-center tracking-[0.5em] focus:outline-none focus:border-neutral-600"
            />
            <button
              type="submit"
              disabled={busy}
              className="w-full h-10 rounded-md bg-neutral-100 text-neutral-950 text-[14px] font-medium hover:bg-white disabled:opacity-50"
            >
              {busy ? 'Verifying…' : 'Verify and sign in'}
            </button>
            <button
              type="button"
              onClick={() => setMode('register-email')}
              className="w-full text-[12px] text-neutral-500 hover:text-neutral-300"
            >
              ← Use a different email
            </button>
          </form>
        )}

        {error && (
          <div className="mt-4 px-3 py-2 rounded-md bg-red-950/40 border border-red-900/60 text-[12px] text-red-400">
            {error}
          </div>
        )}

        <p className="mt-6 text-[11px] text-center text-neutral-600">
          By continuing you agree to the{' '}
          <a href="https://alby.sh/legal/terms" target="_blank" rel="noreferrer" className="underline hover:text-neutral-400">Terms</a>
          {' '}and{' '}
          <a href="https://alby.sh/legal/privacy" target="_blank" rel="noreferrer" className="underline hover:text-neutral-400">Privacy Policy</a>.
        </p>
      </div>
    </div>
  )
}
