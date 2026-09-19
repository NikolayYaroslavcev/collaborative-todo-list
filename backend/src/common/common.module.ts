import { Global, Module } from '@nestjs/common';
import { MembershipService } from './membership.service';

@Global()
@Module({
  providers: [MembershipService],
  exports: [MembershipService],
})
export class CommonModule {}
