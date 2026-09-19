import { useEffect, type ReactNode } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { getSupabase } from "@/api/auth";
import { AnimatePresence, motion } from "motion/react";
import { ApiError } from "@/api/client";
import { authKey, useMe } from "@/api/queries";
import { LoginScreen } from "./LoginScreen";

/**
 * Shows the login until the session is valid, then the dashboard.
 *
 * The switch is animated: the login card blurs out and the dashboard rises in,
 * so signing in reads as arriving rather than as a page swap.
 */

function Splash() {
  return (
    <div className="flex min-h-screen items-center justify-center bg-void" role="status" aria-label="Cargando">
      <motion.span
        className="h-3 w-3 rounded-full bg-solar shadow-[0_0_24px_var(--color-solar)]"
        animate={{ scale: [1, 1.6, 1], opacity: [0.6, 1, 0.6] }}
        transition={{ duration: 1.4, repeat: Infinity }}
      />
    </div>
  );
}

function ServerProblem({ message }: { message: string }) {
  return (
    <div className="flex min-h-screen items-center justify-center bg-void px-4">
      <div className="max-w-md rounded-2xl border border-alert/30 bg-alert/5 px-5 py-4 text-center">
        <p className="text-[13px] font-medium text-alert">No se puede entrar</p>
        <p className="mt-1.5 text-[12.5px] text-ink-dim">{message}</p>
      </div>
    </div>
  );
}

export function AuthGate({ children }: { children: ReactNode }) {
  const me = useMe();
  const client = useQueryClient();

  // Sign-out in another tab, or a refresh token that stopped working, ends up
  // here: re-check the session so the gate follows it.
  useEffect(() => {
    let unsubscribe: (() => void) | undefined;
    void getSupabase()
      .then((supabase) => {
        const { data } = supabase?.auth.onAuthStateChange((event) => {
          if (event === "SIGNED_OUT") void client.invalidateQueries({ queryKey: authKey });
        }) ?? { data: null };
        unsubscribe = () => data?.subscription.unsubscribe();
      })
      .catch(() => undefined);
    return () => unsubscribe?.();
  }, [client]);

  let view: { key: string; node: ReactNode };
  if (me.isPending) {
    view = { key: "splash", node: <Splash /> };
  } else if (me.data) {
    view = { key: "app", node: children };
  } else if (me.error instanceof ApiError && me.error.status === 401) {
    view = { key: "login", node: <LoginScreen /> };
  } else {
    view = {
      key: "problem",
      node: <ServerProblem message={me.error?.message ?? "Error desconocido"} />,
    };
  }

  return (
    <AnimatePresence mode="wait">
      <motion.div
        key={view.key}
        initial={{ opacity: 0, y: view.key === "app" ? 12 : 0 }}
        animate={{ opacity: 1, y: 0 }}
        exit={{ opacity: 0 }}
        transition={{ duration: 0.45, ease: [0.22, 1, 0.36, 1] }}
      >
        {view.node}
      </motion.div>
    </AnimatePresence>
  );
}
