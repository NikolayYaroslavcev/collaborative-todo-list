import { Injectable } from '@nestjs/common';

interface PresenceEntry {
  userId: string;
  name: string;
  socketIds: Set<string>;
  editingTaskId: string | null;
}

export interface PresenceView {
  userId: string;
  name: string;
  online: true;
  editingTaskId: string | null;
}

export interface Editor {
  userId: string;
  name: string;
}

/**
 * Presence is intentionally in-memory only (never persisted to Postgres) —
 * it is ephemeral connection state, not domain data. A single gateway
 * instance is assumed; a multi-instance deployment would need a shared
 * store (e.g. Redis) instead of this Map. The same assumption backs the
 * per-list reorder lock in TasksService.
 */
@Injectable()
export class PresenceService {
  private readonly listPresence = new Map<string, Map<string, PresenceEntry>>();

  addConnection(listId: string, userId: string, name: string, socketId: string) {
    let members = this.listPresence.get(listId);
    if (!members) {
      members = new Map();
      this.listPresence.set(listId, members);
    }

    let entry = members.get(userId);
    if (!entry) {
      entry = { userId, name, socketIds: new Set(), editingTaskId: null };
      members.set(userId, entry);
    }
    entry.socketIds.add(socketId);
  }

  /** Returns true if the user has no more active connections to this list. */
  removeConnection(listId: string, userId: string, socketId: string): boolean {
    const members = this.listPresence.get(listId);
    if (!members) return true;

    const entry = members.get(userId);
    if (!entry) return true;

    entry.socketIds.delete(socketId);
    if (entry.socketIds.size === 0) {
      members.delete(userId);
      if (members.size === 0) {
        this.listPresence.delete(listId);
      }
      return true;
    }
    return false;
  }

  /**
   * Sets (or clears, with taskId `null`) the task a user is currently
   * editing. Returns true if this actually changed the recorded state, so
   * callers can skip broadcasting a no-op presence update — the closest
   * thing to debouncing on the server side; the client is still expected to
   * debounce its own focus/keystroke events before emitting.
   */
  setEditing(listId: string, userId: string, taskId: string | null): boolean {
    const entry = this.listPresence.get(listId)?.get(userId);
    if (!entry) return false;
    if (entry.editingTaskId === taskId) return false;
    entry.editingTaskId = taskId;
    return true;
  }

  /**
   * Clears editing state for a task across all users of a list (used after
   * the task is deleted, so no stale "being edited" indicator lingers).
   * Returns true if any presence entry actually changed.
   */
  clearEditingForTask(listId: string, taskId: string): boolean {
    const members = this.listPresence.get(listId);
    if (!members) return false;
    let changed = false;
    for (const entry of members.values()) {
      if (entry.editingTaskId === taskId) {
        entry.editingTaskId = null;
        changed = true;
      }
    }
    return changed;
  }

  /** Other users (excluding `excludeUserId`) currently editing `taskId`. */
  getEditors(listId: string, taskId: string, excludeUserId?: string): Editor[] {
    const members = this.listPresence.get(listId);
    if (!members) return [];
    const editors: Editor[] = [];
    for (const entry of members.values()) {
      if (entry.editingTaskId === taskId && entry.userId !== excludeUserId) {
        editors.push({ userId: entry.userId, name: entry.name });
      }
    }
    return editors;
  }

  getPresence(listId: string): PresenceView[] {
    const members = this.listPresence.get(listId);
    if (!members) return [];
    return Array.from(members.values()).map((m) => ({
      userId: m.userId,
      name: m.name,
      online: true,
      editingTaskId: m.editingTaskId,
    }));
  }
}
