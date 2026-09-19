import { Injectable } from '@nestjs/common';

interface PresenceEntry {
  userId: string;
  name: string;
  socketIds: Set<string>;
}

/**
 * Presence is intentionally in-memory only (never persisted to Postgres) —
 * it is ephemeral connection state, not domain data. A single gateway
 * instance is assumed; a multi-instance deployment would need a shared
 * store (e.g. Redis) instead of this Map.
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
      entry = { userId, name, socketIds: new Set() };
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

  getPresence(listId: string): Array<{ userId: string; name: string; online: true }> {
    const members = this.listPresence.get(listId);
    if (!members) return [];
    return Array.from(members.values()).map((m) => ({
      userId: m.userId,
      name: m.name,
      online: true,
    }));
  }
}
