"use client";

import { useCallback, useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { useAuth } from "@/lib/auth-context";
import { api, ApiError } from "@/lib/api";
import type { ListSummary } from "@/lib/types";
import { AppShell } from "@/components/AppShell";
import { EmptyState, ErrorState, LoadingState } from "@/components/StateViews";
import { IconChevronRight, IconTrash } from "@/components/icons";
import shared from "@/styles/shared.module.css";
import styles from "./lists.module.css";

export default function ListsPage() {
  const { token, isLoading: authLoading } = useAuth();
  const router = useRouter();

  const [lists, setLists] = useState<ListSummary[] | null>(null);
  const [page, setPage] = useState(1);
  const [totalPages, setTotalPages] = useState(1);
  const [loadingMore, setLoadingMore] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);
  const [newTitle, setNewTitle] = useState("");
  const [createError, setCreateError] = useState<string | null>(null);
  const [pendingDelete, setPendingDelete] = useState<ListSummary | null>(null);
  const [deleting, setDeleting] = useState(false);

  const load = useCallback(async () => {
    if (!token) return;
    setError(null);
    try {
      const data = await api.listLists(token, 1);
      setLists(data.items);
      setPage(data.page);
      setTotalPages(data.totalPages);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Couldn't load your lists.");
    }
  }, [token]);

  async function loadMore() {
    if (!token || loadingMore || page >= totalPages) return;
    setLoadingMore(true);
    try {
      const data = await api.listLists(token, page + 1);
      setLists((prev) => [...(prev ?? []), ...data.items]);
      setPage(data.page);
      setTotalPages(data.totalPages);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Couldn't load more lists.");
    } finally {
      setLoadingMore(false);
    }
  }

  useEffect(() => {
    if (!authLoading && !token) router.replace("/login");
  }, [authLoading, token, router]);

  useEffect(() => {
    // Fetch-on-mount: `load` is async, so it never calls setState
    // synchronously within this effect body — the lint rule can't see
    // through the indirection and flags it anyway.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    void load();
  }, [load]);

  async function handleCreate(e: React.FormEvent) {
    e.preventDefault();
    if (!token || !newTitle.trim()) return;
    setCreating(true);
    setCreateError(null);
    try {
      const list = await api.createList(token, newTitle.trim());
      setNewTitle("");
      router.push(`/lists/${list.id}`);
    } catch (err) {
      setCreateError(err instanceof ApiError ? err.message : "Couldn't create list.");
    } finally {
      setCreating(false);
    }
  }

  async function handleDelete() {
    if (!token || !pendingDelete) return;
    setDeleting(true);
    try {
      await api.deleteList(token, pendingDelete.id);
      setLists((prev) => prev?.filter((l) => l.id !== pendingDelete.id) ?? null);
      setPendingDelete(null);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Couldn't delete list.");
    } finally {
      setDeleting(false);
    }
  }

  if (authLoading || (!token && !authLoading)) return null;

  return (
    <AppShell>
      <div className={styles.headRow}>
        <div>
          <h1 className={styles.title}>Your lists</h1>
          <p className={styles.subtitle}>Shared, realtime todo lists.</p>
        </div>
      </div>

      <form className={styles.createRow} onSubmit={handleCreate}>
        <input
          className={shared.input}
          placeholder="New list title, e.g. Launch checklist"
          value={newTitle}
          onChange={(e) => setNewTitle(e.target.value)}
          maxLength={200}
        />
        <button className={shared.buttonPrimary} type="submit" disabled={creating || !newTitle.trim()}>
          {creating ? <span className={shared.spinner} /> : "Create list"}
        </button>
      </form>
      {createError && <p className={shared.errorText}>{createError}</p>}

      {lists === null && !error && <LoadingState label="Loading your lists…" />}
      {error && <ErrorState message={error} onRetry={load} />}
      {lists && lists.length === 0 && (
        <EmptyState
          title="No lists yet"
          description="Create your first list above, or ask a teammate to invite you to theirs."
        />
      )}

      {lists && lists.length > 0 && (
        <ul className={styles.rows}>
          {lists.map((list) => (
            <li key={list.id} className={styles.row}>
              <button className={styles.rowMain} onClick={() => router.push(`/lists/${list.id}`)}>
                <span className={styles.rowTitle}>{list.title}</span>
                <span className={styles.roleBadge} data-role={list.role}>
                  {list.role === "ADMIN" ? "Admin" : "Member"}
                </span>
                <span className={styles.rowMeta}>
                  {list.taskCount} task{list.taskCount === 1 ? "" : "s"}
                </span>
                <span className={styles.rowMeta}>
                  {list.memberCount} member{list.memberCount === 1 ? "" : "s"}
                </span>
              </button>
              <div className={styles.rowActions}>
                {list.role === "ADMIN" && (
                  <button
                    className={`${shared.iconButton} ${styles.rowDelete}`}
                    aria-label={`Delete ${list.title}`}
                    onClick={() => setPendingDelete(list)}
                  >
                    <IconTrash />
                  </button>
                )}
                <IconChevronRight className={styles.rowChevron} />
              </div>
            </li>
          ))}
        </ul>
      )}

      {lists && page < totalPages && (
        <div className={styles.loadMoreRow}>
          <button className={shared.buttonSecondary} onClick={loadMore} disabled={loadingMore}>
            {loadingMore ? <span className={shared.spinner} /> : "Load more"}
          </button>
        </div>
      )}

      {pendingDelete && (
        <div className={shared.overlay} role="dialog" aria-modal>
          <div className={shared.dialog}>
            <p className={shared.dialogTitle}>Delete &ldquo;{pendingDelete.title}&rdquo;?</p>
            <p className={shared.dialogBody}>
              This permanently deletes the list and all of its tasks for every member. This can&rsquo;t be undone.
            </p>
            <div className={shared.dialogActions}>
              <button className={shared.buttonSecondary} onClick={() => setPendingDelete(null)} disabled={deleting}>
                Cancel
              </button>
              <button className={shared.buttonDanger} onClick={handleDelete} disabled={deleting}>
                {deleting ? <span className={shared.spinner} /> : "Delete list"}
              </button>
            </div>
          </div>
        </div>
      )}
    </AppShell>
  );
}
