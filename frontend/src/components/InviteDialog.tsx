import { useEffect, useRef, useState } from "react";
import { api, ApiError } from "@/lib/api";
import type { ListRole } from "@/lib/types";
import shared from "@/styles/shared.module.css";
import styles from "./InviteDialog.module.css";

export function InviteDialog({
  token,
  listId,
  onClose,
}: {
  token: string;
  listId: string;
  onClose: () => void;
}) {
  const [role, setRole] = useState<ListRole>("MEMBER");
  const [url, setUrl] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  const copiedResetRef = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);

  useEffect(() => () => clearTimeout(copiedResetRef.current), []);

  async function copy(link: string) {
    try {
      await navigator.clipboard.writeText(link);
      setCopied(true);
      clearTimeout(copiedResetRef.current);
      copiedResetRef.current = setTimeout(() => setCopied(false), 2000);
    } catch {
      // Clipboard API unavailable — the link is still selectable/visible.
    }
  }

  async function generate() {
    setLoading(true);
    setError(null);
    setCopied(false);
    try {
      const invite = await api.createInvite(token, listId, role);
      setUrl(invite.url);
      void copy(invite.url);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Couldn't create an invite.");
    } finally {
      setLoading(false);
    }
  }

  return (
    <div className={shared.overlay} role="dialog" aria-modal onClick={onClose}>
      <div className={shared.dialog} onClick={(e) => e.stopPropagation()}>
        <p className={shared.dialogTitle}>Invite someone</p>
        <p className={shared.dialogBody}>
          Generate a link that adds whoever opens it to this list. No email is sent — share the
          link yourself.
        </p>

        <div className={styles.roleRow}>
          <label className={styles.roleOption} data-active={role === "MEMBER"}>
            <input type="radio" name="role" checked={role === "MEMBER"} onChange={() => setRole("MEMBER")} />
            Member
          </label>
          <label className={styles.roleOption} data-active={role === "ADMIN"}>
            <input type="radio" name="role" checked={role === "ADMIN"} onChange={() => setRole("ADMIN")} />
            Admin
          </label>
        </div>

        {url ? (
          <div className={styles.linkBlock}>
            <button className={shared.buttonPrimary} onClick={() => copy(url)}>
              {copied ? "Copied to clipboard" : "Copy invite link"}
            </button>
            <input
              className={styles.linkPreview}
              readOnly
              value={url}
              onFocus={(e) => e.target.select()}
              aria-label="Invite link"
            />
          </div>
        ) : (
          <button className={shared.buttonPrimary} onClick={generate} disabled={loading}>
            {loading ? <span className={shared.spinner} /> : "Generate invite link"}
          </button>
        )}
        {error && <p className={shared.errorText}>{error}</p>}

        <div className={`${shared.dialogActions} ${styles.actions}`}>
          <button className={shared.buttonSecondary} onClick={onClose}>
            Done
          </button>
        </div>
      </div>
    </div>
  );
}
