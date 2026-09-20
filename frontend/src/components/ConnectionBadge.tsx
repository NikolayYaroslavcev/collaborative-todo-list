import type { ConnectionStatus } from "@/lib/use-list-realtime";
import styles from "./ConnectionBadge.module.css";

const LABEL: Record<ConnectionStatus, string> = {
  online: "Online",
  connecting: "Connecting…",
  offline: "Offline",
};

export function ConnectionBadge({
  status,
  pendingCount,
}: {
  status: ConnectionStatus;
  pendingCount: number;
}) {
  return (
    <div className={styles.wrap} data-status={status} title={pendingCount > 0 ? `${pendingCount} change${pendingCount === 1 ? "" : "s"} waiting to sync` : undefined}>
      <span className={styles.dot} />
      <span>{LABEL[status]}</span>
      {pendingCount > 0 && <span className={styles.pending}>{pendingCount} pending</span>}
    </div>
  );
}
