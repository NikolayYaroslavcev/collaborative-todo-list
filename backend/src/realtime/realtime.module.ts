import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module';
import { ListsModule } from '../lists/lists.module';
import { TasksModule } from '../tasks/tasks.module';
import { RealtimeGateway } from './realtime.gateway';
import { PresenceService } from './presence.service';

@Module({
  imports: [AuthModule, ListsModule, TasksModule],
  providers: [RealtimeGateway, PresenceService],
})
export class RealtimeModule {}
