import { generateKeyBetween } from "./fractional-index";
import type { Task } from "./types";

/** Same ordering the backend uses everywhere it lists tasks: fractional
 *  `position` first, `id` as a deterministic tie-break for equal ranks. */
export function sortTasks(tasks: Task[]): Task[] {
  return [...tasks].sort((a, b) => {
    if (a.position !== b.position) return a.position < b.position ? -1 : 1;
    return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
  });
}

/** Optimistic reorder: computes the same fractional `position` the backend
 *  would assign between the new neighbors and applies it immediately.
 *
 *  Display order always comes from `sortTasks`, which sorts strictly by
 *  `position` — it never trusts array order. A naive optimistic reorder that
 *  only splices the array into the new order (without touching `position`)
 *  gets undone by the very next `sortTasks` call, since the moved task's
 *  stale `position` still sorts it back into its old slot. That produced a
 *  visible jump: the row would move to the drop target, snap back to where
 *  it started, then jump again once the server's ack arrived with the real
 *  new position. Assigning the interim position up front keeps the row put
 *  until that ack lands. */
export function applyOptimisticReorder(
  tasks: Task[],
  taskId: string,
  target: { beforeId?: string; afterId?: string },
): Task[] {
  const current = tasks.find((t) => t.id === taskId);
  if (!current) return tasks;

  const beforeTask = target.beforeId ? tasks.find((t) => t.id === target.beforeId) : undefined;
  const afterTask = target.afterId ? tasks.find((t) => t.id === target.afterId) : undefined;

  let position = current.position;
  try {
    position = generateKeyBetween(beforeTask?.position ?? null, afterTask?.position ?? null);
  } catch {
    // Neighbors aren't a valid gap (e.g. a stale drop target) — leave the
    // position as-is. sortTasks() will settle the task near its prior slot
    // until the server's authoritative position arrives.
  }

  return upsertById(tasks, position === current.position ? current : { ...current, position });
}

export function upsertById(tasks: Task[], incoming: Task): Task[] {
  const idx = tasks.findIndex((t) => t.id === incoming.id);
  if (idx === -1) return [...tasks, incoming];
  const next = tasks.slice();
  next[idx] = incoming;
  return next;
}

export function removeById(tasks: Task[], id: string): Task[] {
  return tasks.filter((t) => t.id !== id);
}

export function replaceId(tasks: Task[], fromId: string, incoming: Task): Task[] {
  return upsertById(
    tasks.filter((t) => t.id !== fromId),
    incoming,
  );
}
