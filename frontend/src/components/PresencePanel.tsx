import type { ListMember, PresenceView, Task } from "@/lib/types";
import styles from "./PresencePanel.module.css";

export function PresencePanel({
  members,
  presence,
  tasks,
  currentUserId,
}: {
  members: ListMember[];
  presence: PresenceView[];
  tasks: Task[];
  currentUserId: string | null;
}) {
  const presenceByUser = new Map(presence.map((p) => [p.userId, p]));
  const taskTitleById = new Map(tasks.map((t) => [t.id, t.title]));

  return (
    <div className={styles.panel}>
      <h2 className={styles.heading}>Members</h2>
      <ul className={styles.list}>
        {members.map((member) => {
          const online = presenceByUser.has(member.userId);
          const editingTaskId = presenceByUser.get(member.userId)?.editingTaskId;
          const editingTitle = editingTaskId ? taskTitleById.get(editingTaskId) : null;
          return (
            <li key={member.userId} className={styles.member}>
              <span className={styles.dot} data-online={online} />
              <div className={styles.memberInfo}>
                <span className={styles.memberName}>
                  {member.name}
                  {member.userId === currentUserId ? " (you)" : ""}
                </span>
                {editingTitle && <span className={styles.editing}>editing &ldquo;{editingTitle}&rdquo;</span>}
              </div>
              <span className={styles.roleBadge} data-role={member.role}>
                {member.role === "ADMIN" ? "Admin" : "Member"}
              </span>
            </li>
          );
        })}
      </ul>
    </div>
  );
}
