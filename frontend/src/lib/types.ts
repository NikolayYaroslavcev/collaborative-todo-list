export type ListRole = "ADMIN" | "MEMBER";

export interface AuthUser {
  id: string;
  email: string;
  name: string;
}

export interface ListSummary {
  id: string;
  title: string;
  ownerId: string;
  version: number;
  createdAt: string;
  updatedAt: string;
  role: ListRole;
  memberCount: number;
  taskCount: number;
}

export interface PaginatedLists {
  items: ListSummary[];
  page: number;
  pageSize: number;
  total: number;
  totalPages: number;
}

export interface ListMember {
  userId: string;
  name: string;
  email: string;
  role: ListRole;
}

export interface Task {
  id: string;
  listId: string;
  title: string;
  completed: boolean;
  position: string;
  createdById: string;
  lastEditedById: string | null;
  version: number;
  createdAt: string;
  updatedAt: string;
}

export interface PresenceView {
  userId: string;
  name: string;
  online: true;
  editingTaskId: string | null;
}

export interface ListSnapshot {
  list: {
    id: string;
    title: string;
    ownerId: string;
    version: number;
    createdAt: string;
    updatedAt: string;
  };
  members: ListMember[];
  tasks: Task[];
  version: number;
}

/** `list:sync` payload — the REST snapshot shape plus live presence, which
 *  only exists in the gateway's in-memory state. */
export interface ListSyncPayload extends ListSnapshot {
  presence: PresenceView[];
}

export interface InviteInfo {
  token: string;
  role: ListRole;
  expiresAt: string | null;
  url: string;
}

/** Mirrors the shape NestJS's HttpException filter puts on WS error/conflict
 *  events (`{ event, operationId?, message, code?, ... }`). */
export interface WsErrorPayload {
  event: string;
  operationId?: string;
  status?: number;
  message: string;
  code?: string;
  currentTask?: Task;
  reasons?: string[];
  editedBy?: { userId: string; name: string }[];
  task?: Task;
}
