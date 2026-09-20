/**
 * Pure, framework-free offline operation queue: coalescing rules only, no
 * I/O and no socket knowledge. Kept separate from the realtime hook so the
 * coalescing/persistence logic can be unit tested without a socket or a
 * running backend.
 */

export interface CreatePayload {
  listId: string;
  title: string;
}

export interface UpdatePayload {
  taskId: string;
  title?: string;
  completed?: boolean;
  baseVersion: number;
}

export interface DeletePayload {
  taskId: string;
  force?: boolean;
}

export interface ReorderPayload {
  taskId: string;
  beforeId?: string;
  afterId?: string;
  baseVersion: number;
}

export type PendingOperation =
  | { id: string; type: "task:create"; localId: string; payload: CreatePayload; queuedAt: number }
  | { id: string; type: "task:update"; payload: UpdatePayload; queuedAt: number }
  | { id: string; type: "task:delete"; payload: DeletePayload; queuedAt: number }
  | { id: string; type: "task:reorder"; payload: ReorderPayload; queuedAt: number };

export function newOperationId(): string {
  if (typeof crypto !== "undefined" && "randomUUID" in crypto) {
    return crypto.randomUUID();
  }
  return `op_${Date.now()}_${Math.random().toString(36).slice(2)}`;
}

export const LOCAL_ID_PREFIX = "local:";

export function newLocalId(): string {
  return `${LOCAL_ID_PREFIX}${newOperationId()}`;
}

export function isLocalId(id: string): boolean {
  return id.startsWith(LOCAL_ID_PREFIX);
}

/** Queues an optimistic create. Never coalesced — every create is a
 *  distinct task. */
export function enqueueCreate(
  queue: PendingOperation[],
  operationId: string,
  localId: string,
  payload: CreatePayload,
): PendingOperation[] {
  return [...queue, { id: operationId, type: "task:create", localId, payload, queuedAt: Date.now() }];
}

/**
 * Queues an update. Two coalescing rules keep replay from ever emitting
 * more requests than the user actually needs re-applied:
 *  - If `taskId` refers to a still-unsynced local task (its create is still
 *    queued), the edit is merged directly into that queued create instead
 *    of becoming a separate update — there is no server-side task to
 *    target yet.
 *  - If an update for this task is already queued, the new fields are
 *    merged into it (last-write-wins per field) and the *original*
 *    `baseVersion`/operationId are kept — baseVersion must reflect server
 *    state as of when offline editing started, not a later local edit.
 */
export function enqueueUpdate(
  queue: PendingOperation[],
  operationId: string,
  taskId: string,
  patch: { title?: string; completed?: boolean },
  baseVersion: number,
): PendingOperation[] {
  const pendingCreateIdx = queue.findIndex(
    (op) => op.type === "task:create" && op.localId === taskId,
  );
  if (pendingCreateIdx !== -1) {
    return queue.map((op, i) => {
      if (i !== pendingCreateIdx || op.type !== "task:create") return op;
      return {
        ...op,
        payload: { ...op.payload, ...(patch.title !== undefined ? { title: patch.title } : {}) },
      };
    });
  }

  const existingIdx = queue.findIndex(
    (op) => op.type === "task:update" && op.payload.taskId === taskId,
  );
  if (existingIdx !== -1) {
    return queue.map((op, i) => {
      if (i !== existingIdx || op.type !== "task:update") return op;
      return { ...op, payload: { ...op.payload, ...patch } };
    });
  }

  return [
    ...queue,
    {
      id: operationId,
      type: "task:update",
      payload: { taskId, ...patch, baseVersion },
      queuedAt: Date.now(),
    },
  ];
}

/**
 * Queues a delete. A delete supersedes any pending update/reorder for the
 * same task (there is no point re-applying an edit to a task about to be
 * removed) and, if the task was itself only a queued local create, removes
 * that create outright — it never reached the server, so there's nothing
 * to delete there either.
 */
export function enqueueDelete(
  queue: PendingOperation[],
  operationId: string,
  taskId: string,
  force: boolean,
): PendingOperation[] {
  const pendingCreateIdx = queue.findIndex(
    (op) => op.type === "task:create" && op.localId === taskId,
  );
  if (pendingCreateIdx !== -1) {
    return queue.filter((_, i) => i !== pendingCreateIdx);
  }

  const withoutSuperseded = queue.filter(
    (op) =>
      !(
        (op.type === "task:update" || op.type === "task:reorder") &&
        op.payload.taskId === taskId
      ),
  );

  const existingDeleteIdx = withoutSuperseded.findIndex(
    (op) => op.type === "task:delete" && op.payload.taskId === taskId,
  );
  if (existingDeleteIdx !== -1) {
    return withoutSuperseded.map((op, i) => {
      if (i !== existingDeleteIdx || op.type !== "task:delete") return op;
      return { ...op, payload: { ...op.payload, force: op.payload.force || force } };
    });
  }

  return [
    ...withoutSuperseded,
    { id: operationId, type: "task:delete", payload: { taskId, force }, queuedAt: Date.now() },
  ];
}

/** Queues a reorder. Coalesces with an already-queued reorder of the same
 *  task the same way `enqueueUpdate` does for edits. Reordering a task
 *  that only exists as a queued local create is a caller error (the UI
 *  disables drag for unsynced rows) and is a no-op here. */
export function enqueueReorder(
  queue: PendingOperation[],
  operationId: string,
  taskId: string,
  target: { beforeId?: string; afterId?: string },
  baseVersion: number,
): PendingOperation[] {
  if (queue.some((op) => op.type === "task:create" && op.localId === taskId)) {
    return queue;
  }

  const existingIdx = queue.findIndex(
    (op) => op.type === "task:reorder" && op.payload.taskId === taskId,
  );
  if (existingIdx !== -1) {
    return queue.map((op, i) => {
      if (i !== existingIdx || op.type !== "task:reorder") return op;
      // A reorder target is always a full "insert between these two
      // neighbors" description, never a delta — replace both fields
      // outright rather than spreading, so a drag that drops `afterId`
      // (moved to the end of the list) doesn't leave a stale one behind
      // from an earlier queued drag of the same task.
      return {
        ...op,
        payload: { ...op.payload, beforeId: target.beforeId, afterId: target.afterId },
      };
    });
  }

  return [
    ...queue,
    {
      id: operationId,
      type: "task:reorder",
      payload: { taskId, ...target, baseVersion },
      queuedAt: Date.now(),
    },
  ];
}

export function dequeue(queue: PendingOperation[], operationId: string): PendingOperation[] {
  return queue.filter((op) => op.id !== operationId);
}

function storageKey(listId: string): string {
  return `ctodo.offlineQueue.${listId}`;
}

export function loadQueue(listId: string): PendingOperation[] {
  try {
    const raw = window.localStorage.getItem(storageKey(listId));
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? (parsed as PendingOperation[]) : [];
  } catch {
    return [];
  }
}

export function saveQueue(listId: string, queue: PendingOperation[]): void {
  try {
    if (queue.length === 0) {
      window.localStorage.removeItem(storageKey(listId));
    } else {
      window.localStorage.setItem(storageKey(listId), JSON.stringify(queue));
    }
  } catch {
    // Best-effort persistence only — an in-memory queue still works for the
    // current tab session even if storage is unavailable.
  }
}
