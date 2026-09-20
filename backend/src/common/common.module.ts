import { Global, Module } from '@nestjs/common';
import { MembershipService } from './membership.service';
import { PresenceService } from './presence.service';

@Global()
@Module({
  providers: [MembershipService, PresenceService],
  exports: [MembershipService, PresenceService],
})
export class CommonModule {}
