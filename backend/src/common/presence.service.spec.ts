import { PresenceService } from './presence.service';

describe('PresenceService', () => {
  let presence: PresenceService;

  beforeEach(() => {
    presence = new PresenceService();
  });

  it('reports a user online once any connection is registered, and offline once all are removed', () => {
    presence.addConnection('list-1', 'user-a', 'Alice', 'socket-1');
    expect(presence.getPresence('list-1')).toEqual([
      { userId: 'user-a', name: 'Alice', online: true, editingTaskId: null },
    ]);

    // A second tab/socket for the same user must not create a duplicate entry.
    presence.addConnection('list-1', 'user-a', 'Alice', 'socket-2');
    expect(presence.getPresence('list-1')).toHaveLength(1);

    expect(presence.removeConnection('list-1', 'user-a', 'socket-1')).toBe(false);
    expect(presence.getPresence('list-1')).toHaveLength(1);

    expect(presence.removeConnection('list-1', 'user-a', 'socket-2')).toBe(true);
    expect(presence.getPresence('list-1')).toEqual([]);
  });

  it('setEditing: reports change only when the editing state actually changes (start)', () => {
    presence.addConnection('list-1', 'user-a', 'Alice', 'socket-1');

    expect(presence.setEditing('list-1', 'user-a', 'task-1')).toBe(true);
    expect(presence.setEditing('list-1', 'user-a', 'task-1')).toBe(false); // no-op, unchanged
    expect(presence.getPresence('list-1')[0].editingTaskId).toBe('task-1');
  });

  it('setEditing: reports change on stop, and is a no-op for a user with no connection', () => {
    presence.addConnection('list-1', 'user-a', 'Alice', 'socket-1');
    presence.setEditing('list-1', 'user-a', 'task-1');

    expect(presence.setEditing('list-1', 'user-a', null)).toBe(true);
    expect(presence.getPresence('list-1')[0].editingTaskId).toBeNull();

    expect(presence.setEditing('list-1', 'ghost-user', 'task-1')).toBe(false);
  });

  it('getEditors excludes the given user and only returns editors of the given task', () => {
    presence.addConnection('list-1', 'user-a', 'Alice', 'socket-1');
    presence.addConnection('list-1', 'user-b', 'Bob', 'socket-2');
    presence.setEditing('list-1', 'user-a', 'task-1');
    presence.setEditing('list-1', 'user-b', 'task-2');

    expect(presence.getEditors('list-1', 'task-1')).toEqual([{ userId: 'user-a', name: 'Alice' }]);
    expect(presence.getEditors('list-1', 'task-1', 'user-a')).toEqual([]);
    expect(presence.getEditors('list-1', 'task-2')).toEqual([{ userId: 'user-b', name: 'Bob' }]);
  });

  it('clearEditingForTask clears every editor of that task (e.g. after it is deleted) and reports whether anything changed', () => {
    presence.addConnection('list-1', 'user-a', 'Alice', 'socket-1');
    presence.addConnection('list-1', 'user-b', 'Bob', 'socket-2');
    presence.setEditing('list-1', 'user-a', 'task-1');
    presence.setEditing('list-1', 'user-b', 'task-1');

    expect(presence.clearEditingForTask('list-1', 'task-1')).toBe(true);
    expect(presence.getEditors('list-1', 'task-1')).toEqual([]);
    expect(presence.clearEditingForTask('list-1', 'task-1')).toBe(false); // already clear
  });

  it('keeps presence for separate lists fully independent', () => {
    presence.addConnection('list-1', 'user-a', 'Alice', 'socket-1');
    presence.addConnection('list-2', 'user-a', 'Alice', 'socket-2');
    presence.setEditing('list-1', 'user-a', 'task-1');

    expect(presence.getPresence('list-1')[0].editingTaskId).toBe('task-1');
    expect(presence.getPresence('list-2')[0].editingTaskId).toBeNull();

    presence.removeConnection('list-1', 'user-a', 'socket-1');
    expect(presence.getPresence('list-1')).toEqual([]);
    expect(presence.getPresence('list-2')).toHaveLength(1);
  });
});
