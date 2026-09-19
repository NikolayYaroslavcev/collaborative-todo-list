import { ListRole } from '@prisma/client';
import { IsEnum, IsInt, IsOptional, Min } from 'class-validator';

export class CreateInviteDto {
  @IsOptional()
  @IsEnum(ListRole)
  role?: ListRole;

  @IsOptional()
  @IsInt()
  @Min(1)
  expiresInHours?: number;
}
