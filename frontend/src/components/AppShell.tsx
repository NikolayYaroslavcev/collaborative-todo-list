"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useAuth } from "@/lib/auth-context";
import shared from "@/styles/shared.module.css";
import styles from "./AppShell.module.css";
import { IconArrowLeft } from "./icons";

export function AppShell({
  children,
  right,
  backHref,
}: {
  children: React.ReactNode;
  right?: React.ReactNode;
  backHref?: string;
}) {
  const { user, logout } = useAuth();
  const router = useRouter();

  function handleLogout() {
    logout();
    router.replace("/login");
  }

  return (
    <div className={styles.shell}>
      <header className={styles.header}>
        <div className={styles.headerLeft}>
          {backHref ? (
            <Link href={backHref} className={`${shared.iconButton} ${styles.back}`} aria-label="Back to lists">
              <IconArrowLeft />
            </Link>
          ) : null}
          <Link href="/lists" className={styles.brand}>
            <span className={`${shared.brandMark} ${styles.mark}`} aria-hidden />
            <span className={styles.brandText}>Collaborative Todo</span>
          </Link>
        </div>
        <div className={styles.headerRight}>
          {right}
          {user && (
            <div className={styles.user}>
              <span className={styles.avatar}>{user.name.slice(0, 1).toUpperCase()}</span>
              <span className={styles.userName}>{user.name}</span>
              <button className={shared.buttonGhost} onClick={handleLogout}>
                Sign out
              </button>
            </div>
          )}
        </div>
      </header>
      <main className={styles.main}>{children}</main>
    </div>
  );
}
