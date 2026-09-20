"use client";

import { useState } from "react";
import {
  DndContext,
  type DragEndEvent,
  KeyboardSensor,
  PointerSensor,
  closestCenter,
  useSensor,
  useSensors,
} from "@dnd-kit/core";
import {
  SortableContext,
  arrayMove,
  sortableKeyboardCoordinates,
  useSortable,
  verticalListSortingStrategy,
} from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";
import { isLocalId, type PendingOperation } from "@/lib/offline-queue";
import type { PresenceView, Task } from "@/lib/types";
import type { ConflictInfo } from "@/lib/use-list-realtime";
import shared from "@/styles/shared.module.css";
import styles from "./TaskBoard.module.css";
import { IconChevronDown, IconGrip, IconTrash } from "./icons";

function isPending(taskId: string, pendingOperations: PendingOperation[]): boolean {
  return pendingOperations.some((op) =>
    op.type === "task:create" ? op.localId === taskId : op.payload.taskId === taskId,
  );
}

function Composer({ onCreate }: { onCreate: (title: string) => void }) {
  const [title, setTitle] = useState("");
  return (
    <form
      className={styles.composer}
      onSubmit={(e) => {
        e.preventDefault();
        if (!title.trim()) return;
        onCreate(title);
        setTitle("");
      }}
    >
      <input
        className={shared.input}
        placeholder="Add a task…"
        value={title}
        onChange={(e) => setTitle(e.target.value)}
        maxLength={500}
      />
      <button className={shared.buttonPrimary} type="submit" disabled={!title.trim()}>
        Add
      </button>
    </form>
  );
}

function ConflictBanner({ conflict, onDismiss }: { conflict: ConflictInfo; onDismiss: () => void }) {
  return (
    <div className={styles.conflictBanner}>
      <div>
        <strong>Conflict:</strong> {conflict.message}. The task now shows &ldquo;{conflict.currentTask.title}
        &rdquo; ({conflict.currentTask.completed ? "completed" : "not completed"}) — the latest state from
        the server.
      </div>
      <button className={shared.buttonGhost} onClick={onDismiss}>
        Dismiss
      </button>
    </div>
  );
}

interface RowProps {
  task: Task;
  pending: boolean;
  editors: PresenceView[];
  canDelete: boolean;
  conflict: ConflictInfo | undefined;
  onToggle: () => void;
  onRename: (title: string) => void;
  onStartEdit: () => void;
  onStopEdit: () => void;
  onDeleteRequest: () => void;
  onDismissConflict: () => void;
}

function TaskRow({
  task,
  pending,
  editors,
  canDelete,
  conflict,
  onToggle,
  onRename,
  onStartEdit,
  onStopEdit,
  onDeleteRequest,
  onDismissConflict,
}: RowProps) {
  const local = isLocalId(task.id);
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(task.title);

  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({
    id: task.id,
    disabled: local,
  });

  const style = {
    transform: CSS.Transform.toString(transform),
    transition,
  };

  function commit() {
    setEditing(false);
    onStopEdit();
    const trimmed = draft.trim();
    if (trimmed && trimmed !== task.title) onRename(trimmed);
    else setDraft(task.title);
  }

  return (
    <li
      ref={setNodeRef}
      style={style}
      className={styles.row}
      data-dragging={isDragging}
      data-pending={pending}
    >
      <div className={styles.rowMain}>
        <button
          className={styles.dragHandle}
          aria-label="Drag to reorder"
          disabled={local}
          {...attributes}
          {...listeners}
        >
          <IconGrip />
        </button>

        <input
          type="checkbox"
          className={styles.checkbox}
          checked={task.completed}
          disabled={local}
          onChange={onToggle}
        />

        {editing ? (
          <input
            className={styles.titleInput}
            value={draft}
            autoFocus
            maxLength={500}
            onChange={(e) => setDraft(e.target.value)}
            onFocus={onStartEdit}
            onBlur={commit}
            onKeyDown={(e) => {
              if (e.key === "Enter") e.currentTarget.blur();
              if (e.key === "Escape") {
                setDraft(task.title);
                setEditing(false);
                onStopEdit();
              }
            }}
          />
        ) : (
          <button
            className={styles.title}
            data-completed={task.completed}
            onClick={() => {
              if (local) return;
              setDraft(task.title);
              setEditing(true);
            }}
          >
            {task.title}
          </button>
        )}

        <div className={styles.badges}>
          {local && <span className={styles.badge} data-tone="pending">creating…</span>}
          {!local && pending && <span className={styles.badge} data-tone="pending">syncing…</span>}
          {editors.length > 0 && (
            <span className={styles.badge} data-tone="editing">
              {editors.map((e) => e.name).join(", ")} editing
            </span>
          )}
        </div>

        {canDelete && (
          <button className={styles.deleteButton} aria-label={`Delete ${task.title}`} onClick={onDeleteRequest}>
            <IconTrash />
          </button>
        )}
      </div>
      {conflict && <ConflictBanner conflict={conflict} onDismiss={onDismissConflict} />}
    </li>
  );
}

interface TaskGroupProps {
  tasks: Task[];
  presence: PresenceView[];
  currentUserId: string | null;
  isAdmin: boolean;
  pendingOperations: PendingOperation[];
  conflicts: Record<string, ConflictInfo>;
  onToggle: (task: Task) => void;
  onRename: (taskId: string, title: string) => void;
  onStartEdit: (taskId: string) => void;
  onStopEdit: (taskId: string) => void;
  onReorder: (taskId: string, target: { beforeId?: string; afterId?: string }) => void;
  onDeleteRequest: (task: Task) => void;
  onDismissConflict: (taskId: string) => void;
}

function TaskGroup({
  tasks,
  presence,
  currentUserId,
  isAdmin,
  pendingOperations,
  conflicts,
  onToggle,
  onRename,
  onStartEdit,
  onStopEdit,
  onReorder,
  onDeleteRequest,
  onDismissConflict,
}: TaskGroupProps) {
  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 6 } }),
    useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates }),
  );

  function handleDragEnd(event: DragEndEvent) {
    const { active, over } = event;
    if (!over || active.id === over.id) return;
    const oldIndex = tasks.findIndex((t) => t.id === active.id);
    const newIndex = tasks.findIndex((t) => t.id === over.id);
    if (oldIndex === -1 || newIndex === -1) return;
    const reordered = arrayMove(tasks, oldIndex, newIndex);
    const idx = reordered.findIndex((t) => t.id === active.id);
    onReorder(String(active.id), {
      beforeId: reordered[idx - 1]?.id,
      afterId: reordered[idx + 1]?.id,
    });
  }

  return (
    <DndContext sensors={sensors} collisionDetection={closestCenter} onDragEnd={handleDragEnd}>
      <SortableContext items={tasks.map((t) => t.id)} strategy={verticalListSortingStrategy}>
        <ul className={styles.list}>
          {tasks.map((task) => {
            const editors = presence.filter(
              (p) => p.editingTaskId === task.id && p.userId !== currentUserId,
            );
            const canDelete = isAdmin || (task.createdById === currentUserId && !task.completed);
            return (
              <TaskRow
                key={task.id}
                task={task}
                pending={isPending(task.id, pendingOperations)}
                editors={editors}
                canDelete={canDelete}
                conflict={conflicts[task.id]}
                onToggle={() => onToggle(task)}
                onRename={(title) => onRename(task.id, title)}
                onStartEdit={() => onStartEdit(task.id)}
                onStopEdit={() => onStopEdit(task.id)}
                onDeleteRequest={() => onDeleteRequest(task)}
                onDismissConflict={() => onDismissConflict(task.id)}
              />
            );
          })}
        </ul>
      </SortableContext>
    </DndContext>
  );
}

export function TaskBoard({
  tasks,
  presence,
  currentUserId,
  isAdmin,
  pendingOperations,
  conflicts,
  onCreate,
  onToggle,
  onRename,
  onStartEdit,
  onStopEdit,
  onReorder,
  onDeleteRequest,
  onDismissConflict,
}: {
  tasks: Task[];
  presence: PresenceView[];
  currentUserId: string | null;
  isAdmin: boolean;
  pendingOperations: PendingOperation[];
  conflicts: Record<string, ConflictInfo>;
  onCreate: (title: string) => void;
  onToggle: (task: Task) => void;
  onRename: (taskId: string, title: string) => void;
  onStartEdit: (taskId: string) => void;
  onStopEdit: (taskId: string) => void;
  onReorder: (taskId: string, target: { beforeId?: string; afterId?: string }) => void;
  onDeleteRequest: (task: Task) => void;
  onDismissConflict: (taskId: string) => void;
}) {
  const [completedOpen, setCompletedOpen] = useState(true);

  const activeTasks = tasks.filter((t) => !t.completed);
  const completedTasks = tasks.filter((t) => t.completed);

  const groupProps = {
    presence,
    currentUserId,
    isAdmin,
    pendingOperations,
    conflicts,
    onToggle,
    onRename,
    onStartEdit,
    onStopEdit,
    onReorder,
    onDeleteRequest,
    onDismissConflict,
  };

  return (
    <div>
      <Composer onCreate={onCreate} />

      <div className={styles.section}>
        <div className={styles.sectionHead}>
          <span>Active</span>
          <span className={styles.sectionCount}>{activeTasks.length}</span>
        </div>
        {activeTasks.length > 0 ? (
          <TaskGroup tasks={activeTasks} {...groupProps} />
        ) : (
          <p className={styles.sectionEmpty}>No active tasks.</p>
        )}
      </div>

      {completedTasks.length > 0 && (
        <div className={styles.section}>
          <button className={styles.sectionHead} onClick={() => setCompletedOpen((v) => !v)}>
            <span>Completed</span>
            <span className={styles.sectionCount}>{completedTasks.length}</span>
            <IconChevronDown className={styles.sectionChevron} data-open={completedOpen} />
          </button>
          {completedOpen && <TaskGroup tasks={completedTasks} {...groupProps} />}
        </div>
      )}
    </div>
  );
}
