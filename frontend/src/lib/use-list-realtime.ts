"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import type { Socket } from "socket.io-client";
import { createSocket } from "./socket";
import {
  dequeue,
  enqueueCreate,
  enqueueDelete,
  enqueueReorder,
  enqueueUpdate,
  isLocalId,
  loadQueue,
  newLocalId,
  newOperationId,
  saveQueue,
  type PendingOperation,
} from "./offline-queue";
import { applyOptimisticReorder, removeById, replaceId, sortTasks, upsertById } from "./task-utils";
import type { ListMember, ListSnapshot, ListSyncPayload, PresenceView, Task, WsErrorPayload } from "./types";

export type ConnectionStatus = "connecting" | "online" | "offline";

export interface ConflictInfo {
  taskId: string;
  message: string;
  currentTask: Task;
}

export interface ConfirmDeleteRequest {
  taskId: string;
  task: Task;
  reasons: string[];
  editedBy: { userId: string; name: string }[];
}

export interface Notification {
  id: string;
  tone: "error" | "warning" | "info";
  message: string;
}

interface AckResult {
  ok: boolean;
  kind: "success" | "conflict" | "warning" | "error" | "timeout";
  payload?: WsErrorPayload;
  task?: Task;
}

const ACK_TIMEOUT_MS = 8000;

function taskLabel(task: { title: string } | undefined): string {
  return task ? `"${task.title}"` : "the task";
}

export function useListRealtime(listId: string, token: string | null, currentUserId: string | null) {
  const [list, setList] = useState<ListSnapshot["list"] | null>(null);
  const [members, setMembers] = useState<ListMember[]>([]);
  const [tasks, setTasks] = useState<Task[]>([]);
  const [presence, setPresence] = useState<PresenceView[]>([]);
  const [connectionStatus, setConnectionStatus] = useState<ConnectionStatus>("connecting");
  const [isSyncing, setIsSyncing] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [conflicts, setConflicts] = useState<Record<string, ConflictInfo>>({});
  const [confirmDelete, setConfirmDelete] = useState<ConfirmDeleteRequest | null>(null);
  const [notifications, setNotifications] = useState<Notification[]>([]);
  const [pendingOperations, setPendingOperations] = useState<PendingOperation[]>([]);

  const socketRef = useRef<Socket | null>(null);
  const queueRef = useRef<PendingOperation[]>([]);
  const waitersRef = useRef<Map<string, (result: AckResult) => void>>(new Map());
  const isDrainingRef = useRef(false);

  const notify = useCallback((tone: Notification["tone"], message: string) => {
    const id = newOperationId();
    setNotifications((prev) => [...prev, { id, tone, message }]);
  }, []);

  const dismissNotification = useCallback((id: string) => {
    setNotifications((prev) => prev.filter((n) => n.id !== id));
  }, []);

  const setQueue = useCallback(
    (updater: (queue: PendingOperation[]) => PendingOperation[]) => {
      queueRef.current = updater(queueRef.current);
      saveQueue(listId, queueRef.current);
      setPendingOperations(queueRef.current);
    },
    [listId],
  );

  const resolveWaiter = useCallback((operationId: string | undefined, result: AckResult) => {
    if (!operationId) return;
    const waiter = waitersRef.current.get(operationId);
    if (!waiter) return;
    waitersRef.current.delete(operationId);
    waiter(result);
  }, []);

  const registerWaiter = useCallback((operationId: string): Promise<AckResult> => {
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        waitersRef.current.delete(operationId);
        resolve({ ok: false, kind: "timeout" });
      }, ACK_TIMEOUT_MS);
      waitersRef.current.set(operationId, (result) => {
        clearTimeout(timer);
        resolve(result);
      });
    });
  }, []);

  // -----------------------------------------------------------------------
  // Reconcile: overlay the authoritative server snapshot on top of any
  // still-unsynced local creates, so a task the user made while offline
  // doesn't flicker away the moment `list:sync` reports the pre-replay
  // server state.
  // -----------------------------------------------------------------------
  const reconcileTasks = useCallback((serverTasks: Task[]) => {
    setTasks((prev) => {
      const localPlaceholders = queueRef.current
        .filter((op) => op.type === "task:create")
        .map((op) => prev.find((t) => t.id === (op as { localId: string }).localId))
        .filter((t): t is Task => !!t);
      return [...serverTasks, ...localPlaceholders];
    });
  }, []);

  const clearConflict = useCallback((taskId: string) => {
    setConflicts((prev) => {
      const next = { ...prev };
      delete next[taskId];
      return next;
    });
  }, []);

  // -----------------------------------------------------------------------
  // Queue drain: sends pending operations one at a time, oldest first,
  // stopping (without dropping anything) the moment the socket isn't
  // connected. This is the single code path for both "online" mutations
  // (which drain almost immediately) and offline-queue replay after a
  // reconnect — there is no separate live-vs-replay logic to keep in sync.
  // Declared before the socket-lifecycle effect below so that effect's
  // `list:sync` handler can call it directly, in dependency order.
  // -----------------------------------------------------------------------
  const sendOperation = useCallback(
    async (op: PendingOperation): Promise<AckResult> => {
      const socket = socketRef.current;
      if (!socket?.connected) return { ok: false, kind: "timeout" };

      const waiter = registerWaiter(op.id);
      switch (op.type) {
        case "task:create":
          socket.emit("task:create", {
            listId: op.payload.listId,
            title: op.payload.title,
            operationId: op.id,
          });
          break;
        case "task:update":
          socket.emit("task:update", {
            taskId: op.payload.taskId,
            ...(op.payload.title !== undefined ? { title: op.payload.title } : {}),
            ...(op.payload.completed !== undefined ? { completed: op.payload.completed } : {}),
            baseVersion: op.payload.baseVersion,
            operationId: op.id,
          });
          break;
        case "task:delete":
          socket.emit("task:delete", {
            taskId: op.payload.taskId,
            force: op.payload.force,
            operationId: op.id,
          });
          break;
        case "task:reorder":
          socket.emit("task:reorder", {
            taskId: op.payload.taskId,
            beforeId: op.payload.beforeId,
            afterId: op.payload.afterId,
            baseVersion: op.payload.baseVersion,
            operationId: op.id,
          });
          break;
      }
      return waiter;
    },
    [registerWaiter],
  );

  const handleTerminalFailure = useCallback(
    (op: PendingOperation, result: AckResult) => {
      const status = result.payload?.status;

      if (op.type === "task:create") {
        setTasks((prev) => removeById(prev, op.localId));
        notify("error", `Couldn't create "${op.payload.title}": ${result.payload?.message ?? "failed"}`);
        return;
      }

      if (op.type === "task:delete") {
        if (status === 404) {
          // Already gone — the goal of a delete is achieved either way.
          setTasks((prev) => removeById(prev, op.payload.taskId));
          return;
        }
        // BEING_EDITED / COMPLETED-without-force / permission changes: needs
        // a human decision, not an automatic retry. Surface it and let the
        // user re-issue the delete from the UI (which re-checks live state).
        const label = taskLabel(result.payload?.task);
        notify(
          "warning",
          `Couldn't delete ${label} automatically after reconnecting: ${result.payload?.message ?? "it changed while you were offline"}. Try deleting it again.`,
        );
        socketRef.current?.emit("list:join", { listId });
        return;
      }

      if (op.type === "task:update" || op.type === "task:reorder") {
        if (status === 404) {
          // Deleted server-side while we were offline — must not resurrect it.
          setTasks((prev) => removeById(prev, op.payload.taskId));
          notify("info", "A task you edited offline was deleted by someone else, so your change was dropped.");
          return;
        }
        if (result.kind === "conflict") {
          // Already merged the authoritative task + conflict banner in onTaskConflict.
          return;
        }
        notify(
          "error",
          `Couldn't apply an offline change: ${result.payload?.message ?? "request failed"}.`,
        );
        socketRef.current?.emit("list:join", { listId });
      }
    },
    [listId, notify],
  );

  const drainQueue = useCallback(async () => {
    if (isDrainingRef.current) return;
    isDrainingRef.current = true;
    try {
      for (;;) {
        const socket = socketRef.current;
        if (!socket?.connected) return;
        const op = queueRef.current[0];
        if (!op) return;

        const result = await sendOperation(op);

        if (result.ok) {
          setQueue((q) => dequeue(q, op.id));
          continue;
        }

        if (result.kind === "timeout") {
          // Transient: leave it queued, stop for now. The next reconnect
          // or new enqueue will trigger another drain attempt.
          return;
        }

        // Every other outcome is a terminal, operation-specific decision —
        // the operation must never be retried blindly (it's either already
        // achieved, or invalid against current server state).
        handleTerminalFailure(op, result);
        setQueue((q) => dequeue(q, op.id));
      }
    } finally {
      isDrainingRef.current = false;
    }
  }, [sendOperation, setQueue, handleTerminalFailure]);

  // -----------------------------------------------------------------------
  // Socket lifecycle
  // -----------------------------------------------------------------------
  useEffect(() => {
    if (!token) return;

    queueRef.current = loadQueue(listId);
    setPendingOperations(queueRef.current);

    const socket = createSocket(token);
    socketRef.current = socket;
    setConnectionStatus("connecting");

    const onConnect = () => {
      setConnectionStatus("connecting");
      socket.emit("list:join", { listId });
    };

    const onDisconnect = () => {
      setConnectionStatus("offline");
    };

    const onConnectError = () => {
      setConnectionStatus("offline");
    };

    const onSync = (payload: ListSyncPayload) => {
      setList(payload.list);
      setMembers(payload.members);
      setPresence(payload.presence ?? []);
      reconcileTasks(payload.tasks);
      setIsSyncing(false);
      setLoadError(null);
      setConnectionStatus("online");
      void drainQueue();
    };

    const onTaskCreated = (payload: { task: Task; operationId?: string }) => {
      const pendingCreate = queueRef.current.find(
        (op) => op.type === "task:create" && op.id === payload.operationId,
      ) as Extract<PendingOperation, { type: "task:create" }> | undefined;

      setTasks((prev) =>
        pendingCreate ? replaceId(prev, pendingCreate.localId, payload.task) : upsertById(prev, payload.task),
      );
      resolveWaiter(payload.operationId, { ok: true, kind: "success", task: payload.task });
    };

    const onTaskUpdated = (payload: { task: Task; operationId?: string }) => {
      setTasks((prev) => upsertById(prev, payload.task));
      clearConflict(payload.task.id);
      resolveWaiter(payload.operationId, { ok: true, kind: "success", task: payload.task });
    };

    const onTaskDeleted = (payload: { taskId: string; operationId?: string }) => {
      setTasks((prev) => removeById(prev, payload.taskId));
      clearConflict(payload.taskId);
      resolveWaiter(payload.operationId, { ok: true, kind: "success" });
    };

    const onTaskReordered = (payload: { task: Task; operationId?: string }) => {
      setTasks((prev) => upsertById(prev, payload.task));
      resolveWaiter(payload.operationId, { ok: true, kind: "success", task: payload.task });
    };

    const onPresenceUpdate = (payload: { presence: PresenceView[] }) => {
      setPresence(payload.presence);
    };

    const onTaskConflict = (payload: WsErrorPayload) => {
      if (payload.currentTask) {
        setTasks((prev) => upsertById(prev, payload.currentTask as Task));
        setConflicts((prev) => ({
          ...prev,
          [payload.currentTask!.id]: {
            taskId: payload.currentTask!.id,
            message: payload.message,
            currentTask: payload.currentTask as Task,
          },
        }));
      }
      resolveWaiter(payload.operationId, { ok: false, kind: "conflict", payload });
    };

    const onConflictWarning = (payload: WsErrorPayload) => {
      if (payload.task) {
        setConfirmDelete({
          taskId: payload.task.id,
          task: payload.task,
          reasons: payload.reasons ?? [],
          editedBy: payload.editedBy ?? [],
        });
      }
      resolveWaiter(payload.operationId, { ok: false, kind: "warning", payload });
    };

    const onError = (payload: WsErrorPayload) => {
      resolveWaiter(payload.operationId, { ok: false, kind: "error", payload });
      // Only surface as a top-level notification when nothing was awaiting
      // it (i.e. it wasn't already handled by an in-flight queue send) —
      // e.g. errors on `list:join` itself.
      if (payload.operationId) return;
      if (payload.status === 404 || payload.status === 403) {
        setLoadError(payload.message);
      } else {
        notify("error", payload.message);
      }
    };

    socket.on("connect", onConnect);
    socket.on("disconnect", onDisconnect);
    socket.on("connect_error", onConnectError);
    socket.on("list:sync", onSync);
    socket.on("task:created", onTaskCreated);
    socket.on("task:updated", onTaskUpdated);
    socket.on("task:deleted", onTaskDeleted);
    socket.on("task:reordered", onTaskReordered);
    socket.on("presence:update", onPresenceUpdate);
    socket.on("task:conflict", onTaskConflict);
    socket.on("conflict:warning", onConflictWarning);
    socket.on("error", onError);

    socket.connect();

    const waiters = waitersRef.current;
    return () => {
      socket.emit("list:leave", { listId });
      socket.off();
      socket.disconnect();
      socketRef.current = null;
      waiters.forEach((waiter) => waiter({ ok: false, kind: "timeout" }));
      waiters.clear();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- handlers close over stable useCallback refs (all deps ultimately trace back to `listId`/`[]`), re-created only when listId/token change alongside this effect
  }, [listId, token]);

  // -----------------------------------------------------------------------
  // Presence: editing indicator (debounced by the server; the client just
  // needs to avoid emitting on every keystroke)
  // -----------------------------------------------------------------------
  const editingDebounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const startEditing = useCallback(
    (taskId: string) => {
      if (editingDebounceRef.current) clearTimeout(editingDebounceRef.current);
      editingDebounceRef.current = setTimeout(() => {
        socketRef.current?.emit("presence:editing:start", { listId, taskId });
      }, 150);
    },
    [listId],
  );

  const stopEditing = useCallback(
    (taskId: string) => {
      if (editingDebounceRef.current) clearTimeout(editingDebounceRef.current);
      socketRef.current?.emit("presence:editing:stop", { listId, taskId });
    },
    [listId],
  );

  // Re-attempt the drain whenever connection state flips to online (covers
  // the case where a send raced a disconnect and got left in the queue).
  useEffect(() => {
    if (connectionStatus === "online") void drainQueue();
  }, [connectionStatus, drainQueue]);

  // -----------------------------------------------------------------------
  // Public mutation API — every action is optimistic-first, then enqueued.
  // -----------------------------------------------------------------------
  const createTask = useCallback(
    (title: string) => {
      const trimmed = title.trim();
      if (!trimmed || !currentUserId) return;
      const operationId = newOperationId();
      const localId = newLocalId();
      const now = new Date().toISOString();
      const optimistic: Task = {
        id: localId,
        listId,
        title: trimmed,
        completed: false,
        position: "~pending",
        createdById: currentUserId,
        lastEditedById: currentUserId,
        version: 0,
        createdAt: now,
        updatedAt: now,
      };
      setTasks((prev) => [...prev, optimistic]);
      setQueue((q) => enqueueCreate(q, operationId, localId, { listId, title: trimmed }));
      void drainQueue();
    },
    [currentUserId, listId, setQueue, drainQueue],
  );

  const updateTask = useCallback(
    (taskId: string, patch: { title?: string; completed?: boolean }) => {
      const current = tasks.find((t) => t.id === taskId);
      if (!current) return;
      const operationId = newOperationId();
      setTasks((prev) =>
        upsertById(prev, {
          ...current,
          ...patch,
          updatedAt: new Date().toISOString(),
        }),
      );
      clearConflict(taskId);
      setQueue((q) => enqueueUpdate(q, operationId, taskId, patch, current.version));
      void drainQueue();
    },
    [tasks, setQueue, drainQueue, clearConflict],
  );

  const deleteTask = useCallback(
    (taskId: string, force = false) => {
      const operationId = newOperationId();
      if (isLocalId(taskId)) {
        setTasks((prev) => removeById(prev, taskId));
        setQueue((q) => enqueueDelete(q, operationId, taskId, force));
        return;
      }
      setTasks((prev) => removeById(prev, taskId));
      setConfirmDelete(null);
      clearConflict(taskId);
      setQueue((q) => enqueueDelete(q, operationId, taskId, force));
      void drainQueue();
    },
    [setQueue, drainQueue, clearConflict],
  );

  const reorderTask = useCallback(
    (taskId: string, target: { beforeId?: string; afterId?: string }) => {
      const current = tasks.find((t) => t.id === taskId);
      if (!current || isLocalId(taskId)) return;
      const operationId = newOperationId();

      setTasks((prev) => applyOptimisticReorder(prev, taskId, target));

      setQueue((q) => enqueueReorder(q, operationId, taskId, target, current.version));
      void drainQueue();
    },
    [tasks, setQueue, drainQueue],
  );

  const requestConfirmDelete = useCallback((task: Task, reasons: string[], editedBy: ConfirmDeleteRequest["editedBy"]) => {
    setConfirmDelete({ taskId: task.id, task, reasons, editedBy });
  }, []);

  return {
    list,
    members,
    tasks: sortTasks(tasks),
    presence,
    connectionStatus,
    isSyncing,
    loadError,
    conflicts,
    confirmDelete,
    notifications,
    pendingOperations,
    createTask,
    updateTask,
    deleteTask,
    reorderTask,
    startEditing,
    stopEditing,
    clearConflict,
    dismissNotification,
    requestConfirmDelete,
    cancelConfirmDelete: () => setConfirmDelete(null),
  };
}
