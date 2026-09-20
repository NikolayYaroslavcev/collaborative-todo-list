import { useEffect, useState } from "react";
import type { Notification } from "@/lib/use-list-realtime";
import styles from "./NotificationStack.module.css";
import { IconX } from "./icons";

const EXIT_MS = 160;

function Toast({ notification, onDismiss }: { notification: Notification; onDismiss: (id: string) => void }) {
  const [state, setState] = useState<"entering" | "visible" | "leaving">("entering");

  useEffect(() => {
    const raf = requestAnimationFrame(() => setState("visible"));
    return () => cancelAnimationFrame(raf);
  }, []);

  useEffect(() => {
    if (state !== "visible") return;
    const timer = setTimeout(() => setState("leaving"), notification.tone === "error" ? 9000 : 6000);
    return () => clearTimeout(timer);
  }, [state, notification.tone]);

  useEffect(() => {
    if (state !== "leaving") return;
    const timer = setTimeout(() => onDismiss(notification.id), EXIT_MS);
    return () => clearTimeout(timer);
  }, [state, notification.id, onDismiss]);

  return (
    <div className={styles.toast} data-tone={notification.tone} data-state={state} role="status">
      <span className={styles.dot} aria-hidden />
      <p>{notification.message}</p>
      <button className={styles.close} onClick={() => setState("leaving")} aria-label="Dismiss">
        <IconX />
      </button>
    </div>
  );
}

export function NotificationStack({
  notifications,
  onDismiss,
}: {
  notifications: Notification[];
  onDismiss: (id: string) => void;
}) {
  if (notifications.length === 0) return null;
  return (
    <div className={styles.stack}>
      {notifications.map((n) => (
        <Toast key={n.id} notification={n} onDismiss={onDismiss} />
      ))}
    </div>
  );
}
