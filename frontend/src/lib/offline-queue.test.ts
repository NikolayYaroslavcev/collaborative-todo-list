import { describe, expect, it } from "vitest";
import {
  dequeue,
  enqueueCreate,
  enqueueDelete,
  enqueueReorder,
  enqueueUpdate,
  isLocalId,
  newLocalId,
  newOperationId,
  type PendingOperation,
} from "./offline-queue";

describe("offline-queue id helpers", () => {
  it("generates unique operation ids", () => {
    expect(newOperationId()).not.toBe(newOperationId());
  });

  it("marks local ids as local, and real ids as not", () => {
    const localId = newLocalId();
    expect(isLocalId(localId)).toBe(true);
    expect(isLocalId("real-server-id")).toBe(false);
  });
});

describe("enqueueCreate", () => {
  it("appends a create op and never coalesces (every create is a distinct task)", () => {
    const q1 = enqueueCreate([], "op1", "local:1", { listId: "l1", title: "A" });
    const q2 = enqueueCreate(q1, "op2", "local:2", { listId: "l1", title: "B" });
    expect(q2).toHaveLength(2);
    expect(q2.map((o) => o.id)).toEqual(["op1", "op2"]);
  });
});

describe("enqueueUpdate", () => {
  it("merges an edit into a still-queued create for the same (local) task instead of adding a separate update", () => {
    const q1 = enqueueCreate([], "op-create", "local:1", { listId: "l1", title: "Original" });
    const q2 = enqueueUpdate(q1, "op-update", "local:1", { title: "Edited" }, 0);

    expect(q2).toHaveLength(1);
    expect(q2[0].type).toBe("task:create");
    expect((q2[0] as Extract<PendingOperation, { type: "task:create" }>).payload.title).toBe(
      "Edited",
    );
  });

  it("coalesces a second edit to the same real task into the first queued update, keeping the original baseVersion", () => {
    const q1 = enqueueUpdate([], "op1", "task-1", { title: "First edit" }, 5);
    const q2 = enqueueUpdate(q1, "op2", "task-1", { completed: true }, 7);

    expect(q2).toHaveLength(1);
    const op = q2[0] as Extract<PendingOperation, { type: "task:update" }>;
    expect(op.id).toBe("op1"); // original operationId preserved
    expect(op.payload).toMatchObject({ title: "First edit", completed: true, baseVersion: 5 });
  });

  it("adds a new update op for a task with nothing queued yet", () => {
    const q = enqueueUpdate([], "op1", "task-1", { title: "X" }, 3);
    expect(q).toHaveLength(1);
    expect(q[0]).toMatchObject({ type: "task:update", id: "op1" });
  });
});

describe("enqueueDelete", () => {
  it("removes a still-queued create outright when deleting a not-yet-synced local task", () => {
    const q1 = enqueueCreate([], "op-create", "local:1", { listId: "l1", title: "A" });
    const q2 = enqueueDelete(q1, "op-delete", "local:1", false);
    expect(q2).toEqual([]);
  });

  it("supersedes a pending update/reorder for the same task with the delete", () => {
    let q: PendingOperation[] = [];
    q = enqueueUpdate(q, "op-update", "task-1", { title: "X" }, 1);
    q = enqueueReorder(q, "op-reorder", "task-1", { afterId: "task-2" }, 1);
    q = enqueueDelete(q, "op-delete", "task-1", false);

    expect(q).toHaveLength(1);
    expect(q[0]).toMatchObject({ type: "task:delete", id: "op-delete" });
  });

  it("merges force=true into an already-queued delete for the same task instead of duplicating it", () => {
    let q: PendingOperation[] = [];
    q = enqueueDelete(q, "op1", "task-1", false);
    q = enqueueDelete(q, "op2", "task-1", true);

    expect(q).toHaveLength(1);
    expect(q[0].id).toBe("op1");
    expect((q[0] as Extract<PendingOperation, { type: "task:delete" }>).payload.force).toBe(true);
  });
});

describe("enqueueReorder", () => {
  it("is a no-op when reordering a task that only exists as a queued local create", () => {
    const q1 = enqueueCreate([], "op-create", "local:1", { listId: "l1", title: "A" });
    const q2 = enqueueReorder(q1, "op-reorder", "local:1", { afterId: "task-2" }, 0);
    expect(q2).toEqual(q1);
  });

  it("coalesces a second reorder of the same task into the first, replacing the target", () => {
    const q1 = enqueueReorder([], "op1", "task-1", { afterId: "task-2" }, 1);
    const q2 = enqueueReorder(q1, "op2", "task-1", { beforeId: "task-3" }, 1);

    expect(q2).toHaveLength(1);
    expect(q2[0].id).toBe("op1");
    expect((q2[0] as Extract<PendingOperation, { type: "task:reorder" }>).payload).toMatchObject({
      beforeId: "task-3",
      afterId: undefined,
    });
  });
});

describe("dequeue", () => {
  it("removes only the operation with the matching id", () => {
    let q: PendingOperation[] = [];
    q = enqueueUpdate(q, "op1", "task-1", { title: "A" }, 1);
    q = enqueueUpdate(q, "op2", "task-2", { title: "B" }, 1);

    const next = dequeue(q, "op1");
    expect(next).toHaveLength(1);
    expect(next[0].id).toBe("op2");
  });
});
