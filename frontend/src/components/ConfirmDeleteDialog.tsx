import type { ConfirmDeleteRequest } from "@/lib/use-list-realtime";
import shared from "@/styles/shared.module.css";

const REASON_LABEL: Record<string, string> = {
  COMPLETED: "It's already completed — only an admin can delete a completed task.",
  BEING_EDITED: "Someone else is currently editing it.",
};

export function ConfirmDeleteDialog({
  request,
  onCancel,
  onConfirm,
  confirming,
}: {
  request: ConfirmDeleteRequest;
  onCancel: () => void;
  onConfirm: () => void;
  confirming: boolean;
}) {
  return (
    <div className={shared.overlay} role="dialog" aria-modal>
      <div className={shared.dialog}>
        <p className={shared.dialogTitle}>Delete &ldquo;{request.task.title}&rdquo;?</p>
        <div className={shared.dialogBody}>
          {request.reasons.map((reason) => (
            <p key={reason}>{REASON_LABEL[reason] ?? reason}</p>
          ))}
          {request.editedBy.length > 0 && (
            <p>
              Currently edited by{" "}
              <strong>{request.editedBy.map((e) => e.name).join(", ")}</strong>. Deleting it now
              will discard their in-progress change.
            </p>
          )}
          <p>This action requires confirmation and can&rsquo;t be undone.</p>
        </div>
        <div className={shared.dialogActions}>
          <button className={shared.buttonSecondary} onClick={onCancel} disabled={confirming}>
            Cancel
          </button>
          <button className={shared.buttonDanger} onClick={onConfirm} disabled={confirming}>
            {confirming ? <span className={shared.spinner} /> : "Delete anyway"}
          </button>
        </div>
      </div>
    </div>
  );
}
