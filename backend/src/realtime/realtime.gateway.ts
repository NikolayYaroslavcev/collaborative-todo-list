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
import { ListsService } from '../lists/lists.service';
import { TasksService } from '../tasks/tasks.service';
import { PresenceService } from './presence.service';
import {
  CreateTaskWsDto,
  DeleteTaskWsDto,
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
        this.server.to(listRoom(listId)).emit('presence:update', {
          listId,
          presence: this.presence.getPresence(listId),
        });
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

      this.server.to(listRoom(dto.listId)).emit('presence:update', {
        listId: dto.listId,
        presence: this.presence.getPresence(dto.listId),
      });
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
      this.server.to(listRoom(dto.listId)).emit('presence:update', {
        listId: dto.listId,
        presence: this.presence.getPresence(dto.listId),
      });
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
      client.emit('error', { event, status, ...payload });
      return;
    }

    this.logger.error(`Unexpected WS error on ${event}: ${(error as Error).message}`);
    client.emit('error', { event, message: 'Internal server error' });
  }
}
