import shared from "@/styles/shared.module.css";
import styles from "./StateViews.module.css";

export function LoadingState({ label = "Loading…" }: { label?: string }) {
  return (
    <div className={styles.state}>
      <span className={shared.spinner} />
      <p>{label}</p>
    </div>
  );
}

export function ErrorState({ message, onRetry }: { message: string; onRetry?: () => void }) {
  return (
    <div className={styles.state}>
      <p className={styles.errorIcon} aria-hidden>
        !
      </p>
      <p className={styles.errorMessage}>{message}</p>
      {onRetry && (
        <button className={shared.buttonSecondary} onClick={onRetry}>
          Try again
        </button>
      )}
    </div>
  );
}

export function EmptyState({
  title,
  description,
  action,
}: {
  title: string;
  description?: string;
  action?: React.ReactNode;
}) {
  return (
    <div className={styles.empty}>
      <h3>{title}</h3>
      {description && <p>{description}</p>}
      {action}
    </div>
  );
}
