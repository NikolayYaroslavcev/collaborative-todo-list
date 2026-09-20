"use client";

import { use, useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { useAuth } from "@/lib/auth-context";
import { useListRealtime } from "@/lib/use-list-realtime";
import type { Task } from "@/lib/types";
import { AppShell } from "@/components/AppShell";
import { ConnectionBadge } from "@/components/ConnectionBadge";
import { PresencePanel } from "@/components/PresencePanel";
import { TaskBoard } from "@/components/TaskBoard";
import { ConfirmDeleteDialog } from "@/components/ConfirmDeleteDialog";
import { InviteDialog } from "@/components/InviteDialog";
import { NotificationStack } from "@/components/NotificationStack";
import { EmptyState, ErrorState, LoadingState } from "@/components/StateViews";
import shared from "@/styles/shared.module.css";
import styles from "./list-detail.module.css";

export default function ListDetailPage({ params }: { params: Promise<{ id: string }> }) {
  const { id: listId } = use(params);
  const { token, user, isLoading: authLoading } = useAuth();
  const router = useRouter();

  const {
    list,
    members,
    tasks,
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
    cancelConfirmDelete,
  } = useListRealtime(listId, token, user?.id ?? null);

  const [inviteOpen, setInviteOpen] = useState(false);
  const [confirming, setConfirming] = useState(false);

  useEffect(() => {
    if (!authLoading && !token) router.replace("/login");
  }, [authLoading, token, router]);

  if (authLoading || !token) return null;

  const isAdmin = members.find((m) => m.userId === user?.id)?.role === "ADMIN";

  function handleDeleteRequest(task: Task) {
    const reasons: string[] = [];
    if (task.completed) reasons.push("COMPLETED");
    const editors = presence
      .filter((p) => p.editingTaskId === task.id && p.userId !== user?.id)
      .map((p) => ({ userId: p.userId, name: p.name }));
    if (editors.length > 0) reasons.push("BEING_EDITED");

    if (reasons.length > 0) {
      requestConfirmDelete(task, reasons, editors);
    } else {
      deleteTask(task.id);
    }
  }

  async function handleConfirmDelete() {
    if (!confirmDelete) return;
    setConfirming(true);
    deleteTask(confirmDelete.taskId, true);
    setConfirming(false);
  }

  return (
    <AppShell
      backHref="/lists"
      right={<ConnectionBadge status={connectionStatus} pendingCount={pendingOperations.length} />}
    >
      {loadError ? (
        <ErrorState message={loadError} />
      ) : isSyncing ? (
        <LoadingState label="Loading list…" />
      ) : (
        <div className={styles.layout}>
          <div className={styles.main}>
            <div className={styles.headRow}>
              <h1 className={styles.title}>{list?.title}</h1>
              {isAdmin && (
                <button className={shared.buttonSecondary} onClick={() => setInviteOpen(true)}>
                  Invite
                </button>
              )}
            </div>

            <TaskBoard
              tasks={tasks}
              presence={presence}
              currentUserId={user?.id ?? null}
              isAdmin={isAdmin}
              pendingOperations={pendingOperations}
              conflicts={conflicts}
              onCreate={createTask}
              onToggle={(task) => updateTask(task.id, { completed: !task.completed })}
              onRename={(taskId, title) => updateTask(taskId, { title })}
              onStartEdit={startEditing}
              onStopEdit={stopEditing}
              onReorder={reorderTask}
              onDeleteRequest={handleDeleteRequest}
              onDismissConflict={clearConflict}
            />
            {tasks.length === 0 && (
              <EmptyState title="No tasks yet" description="Add your first task above." />
            )}
          </div>

          <aside className={styles.side}>
            <PresencePanel members={members} presence={presence} tasks={tasks} currentUserId={user?.id ?? null} />
          </aside>
        </div>
      )}

      {confirmDelete && (
        <ConfirmDeleteDialog
          request={confirmDelete}
          onCancel={cancelConfirmDelete}
          onConfirm={handleConfirmDelete}
          confirming={confirming}
        />
      )}

      {inviteOpen && token && (
        <InviteDialog token={token} listId={listId} onClose={() => setInviteOpen(false)} />
      )}

      <NotificationStack notifications={notifications} onDismiss={dismissNotification} />
    </AppShell>
  );
}
