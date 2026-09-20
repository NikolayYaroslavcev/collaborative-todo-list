import type { AuthUser, InviteInfo, ListRole, ListSnapshot, ListSummary, PaginatedLists, Task } from "./types";

const LISTS_PAGE_SIZE = 20;

const API_URL = process.env.NEXT_PUBLIC_API_URL ?? "http://localhost:3001";

export class ApiError extends Error {
  status: number;
  code?: string;
  body: unknown;

  constructor(status: number, message: string, code?: string, body?: unknown) {
    super(message);
    this.name = "ApiError";
    this.status = status;
    this.code = code;
    this.body = body;
  }
}

async function request<T>(
  path: string,
  options: { method?: string; body?: unknown; token?: string | null } = {},
): Promise<T> {
  const res = await fetch(`${API_URL}${path}`, {
    method: options.method ?? "GET",
    headers: {
      "Content-Type": "application/json",
      ...(options.token ? { Authorization: `Bearer ${options.token}` } : {}),
    },
    body: options.body !== undefined ? JSON.stringify(options.body) : undefined,
  });

  if (res.status === 204) {
    return undefined as T;
  }

  const isJson = res.headers.get("content-type")?.includes("application/json");
  const data = isJson ? await res.json().catch(() => undefined) : undefined;

  if (!res.ok) {
    const message =
      (data && typeof data === "object" && "message" in data && String(data.message)) ||
      res.statusText ||
      "Request failed";
    const code =
      data && typeof data === "object" && "code" in data ? String(data.code) : undefined;
    throw new ApiError(res.status, message, code, data);
  }

  return data as T;
}

export const api = {
  login(email: string, password: string) {
    return request<{ accessToken: string; user: AuthUser }>("/auth/login", {
      method: "POST",
      body: { email, password },
    });
  },

  me(token: string) {
    return request<AuthUser>("/auth/me", { token });
  },

  listLists(token: string, page = 1, pageSize = LISTS_PAGE_SIZE) {
    return request<PaginatedLists>(`/lists?page=${page}&pageSize=${pageSize}`, { token });
  },

  createList(token: string, title: string) {
    return request<ListSummary>("/lists", { method: "POST", body: { title }, token });
  },

  deleteList(token: string, listId: string) {
    return request<{ id: string }>(`/lists/${listId}`, { method: "DELETE", token });
  },

  getListSnapshot(token: string, listId: string) {
    return request<ListSnapshot>(`/lists/${listId}`, { token });
  },

  createInvite(token: string, listId: string, role: ListRole = "MEMBER") {
    return request<InviteInfo>(`/lists/${listId}/invite`, {
      method: "POST",
      body: { role },
      token,
    });
  },

  acceptInvite(token: string, inviteToken: string) {
    return request<{ listId: string; role: ListRole }>(`/invites/${inviteToken}/accept`, {
      method: "POST",
      token,
    });
  },

  listTasks(token: string, listId: string) {
    return request<Task[]>(`/lists/${listId}/tasks`, { token });
  },
};
