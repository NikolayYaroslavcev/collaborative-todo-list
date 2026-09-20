import { generateNKeysBetween } from "fractional-indexing";
import { describe, expect, it } from "vitest";
import { applyOptimisticReorder, removeById, replaceId, sortTasks, upsertById } from "./task-utils";
import type { Task } from "./types";

function task(id: string, position: string, overrides: Partial<Task> = {}): Task {
  return {
    id,
    listId: "list-1",
    title: id,
    completed: false,
    position,
    createdById: "user-1",
    lastEditedById: "user-1",
    version: 1,
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    ...overrides,
  };
}

describe("sortTasks", () => {
  it("orders by position ascending", () => {
    const tasks = [task("c", "m"), task("a", "a"), task("b", "g")];
    expect(sortTasks(tasks).map((t) => t.id)).toEqual(["a", "b", "c"]);
  });

  it("breaks ties on equal position by id, matching the backend's (position, id) orderBy", () => {
    const tasks = [task("b", "same"), task("a", "same")];
    expect(sortTasks(tasks).map((t) => t.id)).toEqual(["a", "b"]);
  });

  it("does not mutate the input array", () => {
    const tasks = [task("b", "m"), task("a", "a")];
    const copy = [...tasks];
    sortTasks(tasks);
    expect(tasks).toEqual(copy);
  });
});

describe("upsertById", () => {
  it("adds a task that isn't present yet", () => {
    const result = upsertById([task("a", "a")], task("b", "b"));
    expect(result.map((t) => t.id)).toEqual(["a", "b"]);
  });

  it("replaces a task with the same id in place, preserving array position", () => {
    const original = [task("a", "a"), task("b", "b"), task("c", "c")];
    const updated = task("b", "b", { title: "Renamed" });
    const result = upsertById(original, updated);
    expect(result.map((t) => t.id)).toEqual(["a", "b", "c"]);
    expect(result[1].title).toBe("Renamed");
  });
});

describe("removeById", () => {
  it("removes the task with the given id and leaves the rest untouched", () => {
    const result = removeById([task("a", "a"), task("b", "b")], "a");
    expect(result.map((t) => t.id)).toEqual(["b"]);
  });

  it("is a no-op if the id isn't present", () => {
    const original = [task("a", "a")];
    expect(removeById(original, "missing")).toEqual(original);
  });
});

describe("applyOptimisticReorder", () => {
  // Regression test: dragging a task used to only splice the in-memory array
  // into the new order without touching `position`. Since the realtime hook
  // always re-derives display order from `sortTasks` (which sorts strictly
  // by `position`), the very next render snapped the task straight back to
  // its old slot — a visible jump — until the server's ack arrived with a
  // real new position and moved it again.
  // Positions must be real fractional-indexing keys (as the backend
  // generates), not arbitrary strings — the library rejects out-of-scheme
  // keys, so fixtures use the same generator to stay realistic.
  const [posA, posB, posC] = generateNKeysBetween(null, null, 3);

  it("assigns the moved task a position between its new neighbors, so sortTasks keeps it in its dropped slot", () => {
    const tasks = [task("a", posA), task("b", posB), task("c", posC)];
    // Drag "a" to sit between "b" and "c".
    const result = applyOptimisticReorder(tasks, "a", { beforeId: "b", afterId: "c" });
    expect(sortTasks(result).map((t) => t.id)).toEqual(["b", "a", "c"]);
  });

  it("moves the task to the front when dropped with no beforeId", () => {
    const tasks = [task("a", posA), task("b", posB), task("c", posC)];
    const result = applyOptimisticReorder(tasks, "c", { afterId: "a" });
    expect(sortTasks(result).map((t) => t.id)).toEqual(["c", "a", "b"]);
  });

  it("moves the task to the end when dropped with no afterId", () => {
    const tasks = [task("a", posA), task("b", posB), task("c", posC)];
    const result = applyOptimisticReorder(tasks, "a", { beforeId: "c" });
    expect(sortTasks(result).map((t) => t.id)).toEqual(["b", "c", "a"]);
  });

  it("falls back to leaving the position unchanged if the neighbors have no gap between them (e.g. a legitimate position tie)", () => {
    // Equal ranks can occur by coincidence (see backend tasks.service.ts) —
    // generateKeyBetween throws when there's no room between two equal keys.
    const tasks = [task("a", posA), task("b", posB), task("d", posB)];
    const result = applyOptimisticReorder(tasks, "a", { beforeId: "b", afterId: "d" });
    expect(result.find((t) => t.id === "a")?.position).toBe(posA);
  });

  it("is a no-op if the task isn't present", () => {
    const tasks = [task("a", posA), task("b", posB)];
    expect(applyOptimisticReorder(tasks, "missing", { beforeId: "a" })).toEqual(tasks);
  });
});

describe("replaceId", () => {
  it("swaps a local placeholder id for the real server task (create reconciliation)", () => {
    const original = [task("local:temp", "~pending", { title: "New task" })];
    const real = task("server-id-1", "a0", { title: "New task" });
    const result = replaceId(original, "local:temp", real);
    expect(result.map((t) => t.id)).toEqual(["server-id-1"]);
  });

  it("dedupes instead of creating a second row if the real task was already present (e.g. from a list:sync race)", () => {
    const real = task("server-id-1", "a0", { title: "New task" });
    const original = [task("local:temp", "~pending", { title: "New task" }), real];
    const result = replaceId(original, "local:temp", real);
    expect(result).toHaveLength(1);
    expect(result[0].id).toBe("server-id-1");
  });
});
