"use client";

import { Suspense, useEffect, useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { useAuth } from "@/lib/auth-context";
import { ApiError } from "@/lib/api";
import shared from "@/styles/shared.module.css";
import styles from "./login.module.css";

function LoginForm() {
  const { token, isLoading, login } = useAuth();
  const router = useRouter();
  const searchParams = useSearchParams();
  const next = searchParams.get("next");
  const [email, setEmail] = useState("admin@example.com");
  const [password, setPassword] = useState("password123");
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  useEffect(() => {
    if (!isLoading && token) router.replace(next && next.startsWith("/") ? next : "/lists");
  }, [isLoading, token, router, next]);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    setSubmitting(true);
    try {
      await login(email, password);
      router.replace(next && next.startsWith("/") ? next : "/lists");
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Couldn't sign in. Try again.");
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <main className={styles.page}>
      <div className={styles.panel}>
        <div className={styles.brand}>
          <span className={`${shared.brandMark} ${styles.mark}`} aria-hidden />
          <span>Collaborative Todo</span>
        </div>

        <form className={styles.form} onSubmit={handleSubmit}>
          <h1 className={styles.title}>Sign in</h1>
          <p className={styles.subtitle}>Realtime lists, shared with your team.</p>

          <label className={styles.field}>
            <span>Email</span>
            <input
              className={shared.input}
              type="email"
              autoComplete="email"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              required
            />
          </label>

          <label className={styles.field}>
            <span>Password</span>
            <input
              className={shared.input}
              type="password"
              autoComplete="current-password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              required
            />
          </label>

          {error && <p className={shared.errorText}>{error}</p>}

          <button className={shared.buttonPrimary} type="submit" disabled={submitting}>
            {submitting ? <span className={shared.spinner} /> : "Sign in"}
          </button>
        </form>

        <div className={styles.hint}>
          <p>Seeded accounts</p>
          <code>admin@example.com / password123</code>
          <code>member@example.com / password123</code>
        </div>
      </div>
    </main>
  );
}

export default function LoginPage() {
  return (
    <Suspense fallback={null}>
      <LoginForm />
    </Suspense>
  );
}
