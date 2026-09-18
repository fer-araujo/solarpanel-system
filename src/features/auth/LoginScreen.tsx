import { useState } from "react";
import { motion, useReducedMotion } from "motion/react";
import { ApiError } from "@/api/client";
import { useLogin } from "@/api/queries";
import { Spinner } from "@/ui/primitives/Skeleton";

/**
 * Login. Dark, quiet, one emerald accent: a sun whose rays turn slowly, a card
 * that shakes on a wrong password, and a glow that swells on success before
 * the dashboard fades in.
 */

function SunEmblem({ busy }: { busy: boolean }) {
  const reduced = useReducedMotion();
  return (
    <div className="relative mx-auto h-20 w-20">
      <motion.div
        aria-hidden="true"
        className="absolute inset-0 rounded-full bg-solar/20 blur-xl"
        animate={reduced ? {} : { scale: [1, 1.25, 1], opacity: [0.5, 0.9, 0.5] }}
        transition={{ duration: busy ? 1.2 : 3.2, repeat: Infinity, ease: "easeInOut" }}
      />
      <motion.svg
        viewBox="-40 -40 80 80"
        className="relative h-20 w-20"
        animate={reduced ? {} : { rotate: 360 }}
        transition={{ duration: busy ? 4 : 24, repeat: Infinity, ease: "linear" }}
        aria-hidden="true"
      >
        {Array.from({ length: 12 }, (_, i) => {
          const a = (i / 12) * Math.PI * 2;
          return (
            <line
              key={i}
              x1={Math.cos(a) * 22}
              y1={Math.sin(a) * 22}
              x2={Math.cos(a) * (i % 2 ? 29 : 33)}
              y2={Math.sin(a) * (i % 2 ? 29 : 33)}
              stroke="var(--color-solar)"
              strokeWidth="2.4"
              strokeLinecap="round"
              opacity={i % 2 ? 0.55 : 1}
            />
          );
        })}
      </motion.svg>
      <div className="absolute inset-[30%] rounded-full bg-gradient-to-br from-solar-lift to-solar shadow-[0_0_30px_rgba(16,185,129,0.55)]" />
    </div>
  );
}

export function LoginScreen() {
  const login = useLogin();
  const reduced = useReducedMotion();
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [showPassword, setShowPassword] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [shakeKey, setShakeKey] = useState(0);

  function onSubmit(event: React.FormEvent) {
    event.preventDefault();
    if (!email.trim() || !password) {
      setError("Escribe tu correo y contraseña.");
      setShakeKey((k) => k + 1);
      return;
    }
    setError(null);
    login.mutate(
      { email: email.trim(), password },
      {
        onError: (e) => {
          setError(e instanceof ApiError ? e.message : "No se pudo conectar con el servidor.");
          setShakeKey((k) => k + 1);
          setPassword("");
        },
      },
    );
  }

  const inputClass =
    "mt-1.5 w-full rounded-xl border border-line bg-void/60 px-3.5 py-2.5 text-[14px] text-ink outline-none transition-colors placeholder:text-ink-faint focus:border-solar/60 focus:bg-void";

  return (
    <div className="relative flex min-h-screen items-center justify-center overflow-hidden bg-void px-4">
      {/* Ambient light: two slow emerald washes. */}
      <div aria-hidden="true" className="grain pointer-events-none absolute inset-0" />
      <motion.div
        aria-hidden="true"
        className="pointer-events-none absolute -top-40 left-1/2 h-[520px] w-[520px] -translate-x-1/2 rounded-full bg-solar/10 blur-3xl"
        animate={reduced ? {} : { y: [0, 30, 0] }}
        transition={{ duration: 12, repeat: Infinity, ease: "easeInOut" }}
      />

      <motion.main
        initial={{ opacity: 0, y: 16, scale: 0.98 }}
        animate={{ opacity: 1, y: 0, scale: 1 }}
        exit={{ opacity: 0, scale: 1.04, filter: "blur(6px)" }}
        transition={{ duration: 0.5, ease: [0.22, 1, 0.36, 1] }}
        className="relative w-full max-w-[380px]"
      >
        <motion.div
          key={shakeKey}
          animate={shakeKey > 0 && !reduced ? { x: [0, -10, 10, -6, 6, 0] } : {}}
          transition={{ duration: 0.4 }}
          className="rounded-3xl border border-line/70 bg-surface/80 p-8 shadow-2xl shadow-black/50 backdrop-blur-xl"
        >
          <SunEmblem busy={login.isPending} />

          <h1 className="mt-6 text-center text-[22px] font-medium tracking-tight text-ink">Solar</h1>
          <p className="mt-1 text-center text-[13px] text-ink-faint">Tu planta y tu recibo, en un vistazo</p>

          <form onSubmit={onSubmit} className="mt-7 space-y-4" noValidate>
            <div>
              <label htmlFor="login-email" className="text-[11px] font-medium tracking-[0.08em] text-ink-faint uppercase">
                Correo
              </label>
              <input
                id="login-email"
                type="email"
                inputMode="email"
                autoFocus
                autoComplete="email"
                value={email}
                onChange={(e) => {
                  setEmail(e.target.value);
                  setError(null);
                }}
                className={inputClass}
              />
            </div>

            <div>
              <label htmlFor="login-password" className="text-[11px] font-medium tracking-[0.08em] text-ink-faint uppercase">
                Contraseña
              </label>
              <div className="relative">
                <input
                  id="login-password"
                  type={showPassword ? "text" : "password"}
                  autoComplete="current-password"
                  value={password}
                  onChange={(e) => {
                    setPassword(e.target.value);
                    setError(null);
                  }}
                  className={`${inputClass} pr-12`}
                />
                <button
                  type="button"
                  onClick={() => setShowPassword((v) => !v)}
                  aria-label={showPassword ? "Ocultar contraseña" : "Mostrar contraseña"}
                  className="absolute top-1/2 right-2 mt-[3px] -translate-y-1/2 rounded-lg p-2 text-ink-faint transition-colors hover:text-ink"
                >
                  <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" aria-hidden="true">
                    <path d="M2 12s3.6-7 10-7 10 7 10 7-3.6 7-10 7-10-7-10-7Z" />
                    <circle cx="12" cy="12" r="3" />
                    {showPassword && <path d="M3 3l18 18" />}
                  </svg>
                </button>
              </div>
            </div>

            <div className="min-h-[20px]">
              {error && (
                <motion.p
                  role="alert"
                  initial={{ opacity: 0, y: -4 }}
                  animate={{ opacity: 1, y: 0 }}
                  className="text-[12.5px] text-alert"
                >
                  {error}
                </motion.p>
              )}
            </div>

            <motion.button
              type="submit"
              disabled={login.isPending}
              whileHover={reduced ? {} : { y: -1 }}
              whileTap={reduced ? {} : { scale: 0.98 }}
              className="flex w-full items-center justify-center gap-2 rounded-xl bg-solar px-4 py-3 text-[14px] font-medium text-void shadow-[0_8px_30px_-8px_rgba(16,185,129,0.6)] transition-colors hover:bg-solar-lift disabled:opacity-70"
            >
              {login.isPending ? (
                <>
                  <Spinner />
                  Entrando…
                </>
              ) : (
                "Entrar"
              )}
            </motion.button>
          </form>
        </motion.div>
      </motion.main>
    </div>
  );
}
