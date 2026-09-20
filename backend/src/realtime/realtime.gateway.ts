import { HttpException, HttpStatus, Logger, UsePipes, ValidationPipe } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import {
  ConnectedSocket,
  MessageBody,
  OnGatewayDisconnect,
  OnGatewayInit,
  SubscribeMessage,
  WebSocketGateway,
  WebSocketServer,
} from '@nestjs/websockets';
import { Server, Socket } from 'socket.io';
import { AuthService } from '../auth/auth.service';
import { JwtPayload, AuthenticatedUser } from '../auth/types';
import { MembershipService } from '../common/membership.service';
import { PresenceService } from '../common/presence.service';
import { ListsService } from '../lists/lists.service';
import { TasksService } from '../tasks/tasks.service';
import {
  CreateTaskWsDto,
  DeleteTaskWsDto,
  EditingStartDto,
  EditingStopDto,
  JoinListDto,
  ReorderTaskWsDto,
  UpdateTaskWsDto,
} from './dto/ws-payloads.dto';

interface AuthenticatedSocket extends Socket {
  data: {
    user: AuthenticatedUser;
    joinedLists: Set<string>;
  };
}

const listRoom = (listId: string) => `list:${listId}`;

/** Trailing-edge debounce window for editing-state presence broadcasts: a
 *  burst of start/stop calls within this window collapses into a single
 *  broadcast of the final state once things go quiet. Online/offline
 *  transitions (join/leave/disconnect) are never debounced — those are
 *  significant events, not input noise. */
const PRESENCE_EDITING_DEBOUNCE_MS = 300;

@WebSocketGateway({
  cors: {
    origin: process.env.CORS_ORIGIN ?? 'http://localhost:3000',
    credentials: true,
  },
})
export class RealtimeGateway implements OnGatewayInit, OnGatewayDisconnect {
  @WebSocketServer()
  server: Server;

  private readonly logger = new Logger(RealtimeGateway.name);

  /** Pending debounced presence broadcasts, keyed by `${listId}:${userId}`. */
  private readonly presenceDebounceTimers = new Map<string, NodeJS.Timeout>();

  constructor(
    private readonly jwtService: JwtService,
    private readonly authService: AuthService,
    private readonly membership: MembershipService,
    private readonly listsService: ListsService,
    private readonly tasksService: TasksService,
    private readonly presence: PresenceService,
  ) {}

  /**
   * Auth runs as a Socket.IO middleware (not the `handleConnection` lifecycle
   * hook) so the handshake itself blocks on the async user lookup. Using
   * `handleConnection` instead would let the client's `connect` event fire
   * before `client.data.user` is set, racing with the client's first emit.
   */
  afterInit(server: Server) {
    server.use((socket: AuthenticatedSocket, next) => {
      void (async () => {
        try {
          const token = this.extractToken(socket);
          if (!token) {
            throw new Error('Missing auth token');
          }

          const payload = this.jwtService.verify<JwtPayload>(token);
          const user = await this.authService.validateUserById(payload.sub);
          if (!user) {
            throw new Error('Invalid user');
          }

          socket.data.user = user;
          socket.data.joinedLists = new Set();
          next();
        } catch (error) {
          this.logger.warn(`WS auth failed for socket ${socket.id}: ${(error as Error).message}`);
          next(new Error('Unauthorized'));
        }
      })();
    });
  }

  handleDisconnect(client: AuthenticatedSocket) {
    const joinedLists = client.data?.joinedLists;
    if (!joinedLists) return;

    for (const listId of joinedLists) {
      const wentOffline = this.presence.removeConnection(listId, client.data.user.id, client.id);
      if (wentOffline) {
        // Going offline is authoritative and immediate: don't let a
        // still-pending debounced editing broadcast fire later re-stating
        // presence that's already been superseded (harmless, since
        // getPresence() is always read fresh, but pointless network noise).
        this.cancelPendingPresenceBroadcast(listId, client.data.user.id);
        this.broadcastPresence(listId);
      }
    }
  }

  private extractToken(client: Socket): string | null {
    const authToken = client.handshake.auth?.token as string | undefined;
    if (authToken) return authToken;

    const header = client.handshake.headers.authorization;
    if (header?.startsWith('Bearer ')) {
      return header.slice('Bearer '.length);
    }
    return null;
  }

  @UsePipes(new ValidationPipe({ whitelist: true, transform: true }))
  @SubscribeMessage('list:join')
  async handleJoin(
    @ConnectedSocket() client: AuthenticatedSocket,
    @MessageBody() dto: JoinListDto,
  ) {
    try {
      const snapshot = await this.listsService.getListSnapshot(dto.listId, client.data.user.id);

      await client.join(listRoom(dto.listId));
      client.data.joinedLists.add(dto.listId);
      this.presence.addConnection(
        dto.listId,
        client.data.user.id,
        client.data.user.name,
        client.id,
      );

      client.emit('list:sync', {
        list: snapshot.list,
        tasks: snapshot.tasks,
        members: snapshot.members,
        version: snapshot.version,
        presence: this.presence.getPresence(dto.listId),
      });

      this.broadcastPresence(dto.listId);
    } catch (error) {
      this.handleError(client, 'list:join', error);
    }
  }

  @SubscribeMessage('list:leave')
  handleLeave(@ConnectedSocket() client: AuthenticatedSocket, @MessageBody() dto: JoinListDto) {
    client.leave(listRoom(dto.listId));
    client.data.joinedLists.delete(dto.listId);
    const wentOffline = this.presence.removeConnection(dto.listId, client.data.user.id, client.id);
    if (wentOffline) {
      this.cancelPendingPresenceBroadcast(dto.listId, client.data.user.id);
      this.broadcastPresence(dto.listId);
    }
  }

  @UsePipes(new ValidationPipe({ whitelist: true, transform: true }))
  @SubscribeMessage('presence:editing:start')
  handleEditingStart(
    @ConnectedSocket() client: AuthenticatedSocket,
    @MessageBody() dto: EditingStartDto,
  ) {
    if (!client.data.joinedLists?.has(dto.listId)) return;

    // The presence *state* updates immediately and synchronously (so e.g.
    // the being-edited check in TasksService.deleteTask always sees the
    // true current state) — only the outgoing broadcast to other clients is
    // debounced, to avoid spamming the room while someone is actively
    // typing/focusing between tasks.
    const changed = this.presence.setEditing(dto.listId, client.data.user.id, dto.taskId);
    if (changed) {
      this.debouncedBroadcastPresence(dto.listId, client.data.user.id);
    }
  }

  @UsePipes(new ValidationPipe({ whitelist: true, transform: true }))
  @SubscribeMessage('presence:editing:stop')
  handleEditingStop(
    @ConnectedSocket() client: AuthenticatedSocket,
    @MessageBody() dto: EditingStopDto,
  ) {
    if (!client.data.joinedLists?.has(dto.listId)) return;

    // Only clear if this client's editingTaskId is still the one it's
    // reporting as stopped — a stop for taskA arriving after a newer
    // start for taskB (out-of-order delivery) must not clobber taskB.
    const current = this.presence
      .getPresence(dto.listId)
      .find((p) => p.userId === client.data.user.id);
    if (current?.editingTaskId !== dto.taskId) return;

    const changed = this.presence.setEditing(dto.listId, client.data.user.id, null);
    if (changed) {
      this.debouncedBroadcastPresence(dto.listId, client.data.user.id);
    }
  }

  private broadcastPresence(listId: string) {
    this.server.to(listRoom(listId)).emit('presence:update', {
      listId,
      presence: this.presence.getPresence(listId),
    });
  }

  /**
   * Trailing-edge debounce for editing-state presence broadcasts: a rapid
   * burst of start/stop calls from one user in one list resets the timer
   * each time, so only a single `presence:update` goes out once things go
   * quiet for `PRESENCE_EDITING_DEBOUNCE_MS`, reflecting whatever the final
   * state ended up being. The underlying presence state itself (read via
   * `presence.getPresence`) is always up to date immediately — only the
   * network notification is throttled.
   */
  private debouncedBroadcastPresence(listId: string, userId: string) {
    const key = `${listId}:${userId}`;
    const existing = this.presenceDebounceTimers.get(key);
    if (existing) clearTimeout(existing);

    const timer = setTimeout(() => {
      this.presenceDebounceTimers.delete(key);
      this.broadcastPresence(listId);
    }, PRESENCE_EDITING_DEBOUNCE_MS);
    // Don't let a pending debounce timer keep the process alive on its own.
    timer.unref?.();
    this.presenceDebounceTimers.set(key, timer);
  }

  private cancelPendingPresenceBroadcast(listId: string, userId: string) {
    const key = `${listId}:${userId}`;
    const existing = this.presenceDebounceTimers.get(key);
    if (existing) {
      clearTimeout(existing);
      this.presenceDebounceTimers.delete(key);
    }
  }

  @UsePipes(new ValidationPipe({ whitelist: true, transform: true }))
  @SubscribeMessage('task:create')
  async handleCreate(
    @ConnectedSocket() client: AuthenticatedSocket,
    @MessageBody() dto: CreateTaskWsDto,
  ) {
    try {
      const { task, listVersion } = await this.tasksService.createTask(
        dto.listId,
        client.data.user.id,
        dto.title,
      );
      this.server.to(listRoom(dto.listId)).emit('task:created', { task, listVersion });
    } catch (error) {
      this.handleError(client, 'task:create', error);
    }
  }

  @UsePipes(new ValidationPipe({ whitelist: true, transform: true }))
  @SubscribeMessage('task:update')
  async handleUpdate(
    @ConnectedSocket() client: AuthenticatedSocket,
    @MessageBody() dto: UpdateTaskWsDto,
  ) {
    try {
      const { task, listVersion } = await this.tasksService.updateTask(
        dto.taskId,
        client.data.user.id,
        {
          title: dto.title,
          completed: dto.completed,
          baseVersion: dto.baseVersion,
        },
      );
      this.server.to(listRoom(task.listId)).emit('task:updated', { task, listVersion });
    } catch (error) {
      this.handleError(client, 'task:update', error);
    }
  }

  @UsePipes(new ValidationPipe({ whitelist: true, transform: true }))
  @SubscribeMessage('task:delete')
  async handleDelete(
    @ConnectedSocket() client: AuthenticatedSocket,
    @MessageBody() dto: DeleteTaskWsDto,
  ) {
    try {
      const { taskId, listId, listVersion } = await this.tasksService.deleteTask(
        dto.taskId,
        client.data.user.id,
        dto.force ?? false,
      );
      this.server.to(listRoom(listId)).emit('task:deleted', { taskId, listVersion });

      // Don't leave a stale "being edited" badge pointing at a task that no
      // longer exists. Capture who was editing before clearing it, so any
      // of their pending debounced broadcasts can be cancelled — they're
      // about to be superseded by the immediate broadcast below anyway.
      const editorsBeforeClear = this.presence.getEditors(listId, taskId);
      if (this.presence.clearEditingForTask(listId, taskId)) {
        for (const editor of editorsBeforeClear) {
          this.cancelPendingPresenceBroadcast(listId, editor.userId);
        }
        this.broadcastPresence(listId);
      }
    } catch (error) {
      this.handleError(client, 'task:delete', error);
    }
  }

  @UsePipes(new ValidationPipe({ whitelist: true, transform: true }))
  @SubscribeMessage('task:reorder')
  async handleReorder(
    @ConnectedSocket() client: AuthenticatedSocket,
    @MessageBody() dto: ReorderTaskWsDto,
  ) {
    try {
      const { task, listVersion } = await this.tasksService.reorderTask(
        dto.taskId,
        client.data.user.id,
        {
          beforeId: dto.beforeId,
          afterId: dto.afterId,
          baseVersion: dto.baseVersion,
          operationId: dto.operationId,
        },
      );
      this.server.to(listRoom(task.listId)).emit('task:reordered', { task, listVersion });
    } catch (error) {
      this.handleError(client, 'task:reorder', error);
    }
  }

  private handleError(client: Socket, event: string, error: unknown) {
    if (error instanceof HttpException) {
      const status = error.getStatus();
      const response = error.getResponse();
      const payload = typeof response === 'string' ? { message: response } : response;

      if (status === HttpStatus.CONFLICT) {
        client.emit('task:conflict', { event, ...payload });
        return;
      }

      // A delete blocked by an active editor is a soft warning, not a hard
      // error: the client is expected to show a confirmation dialog and, if
      // the user confirms, resend the same request with `force: true`.
      const reasons = (payload as { reasons?: string[] }).reasons;
      if (status === HttpStatus.BAD_REQUEST && reasons?.includes('BEING_EDITED')) {
        client.emit('conflict:warning', { event, ...payload });
        return;
      }

      client.emit('error', { event, status, ...payload });
      return;
    }

    this.logger.error(`Unexpected WS error on ${event}: ${(error as Error).message}`);
    client.emit('error', { event, message: 'Internal server error' });
  }
}
