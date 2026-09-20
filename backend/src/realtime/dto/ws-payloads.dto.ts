import { IsBoolean, IsInt, IsOptional, IsString, Length, Min } from 'class-validator';

export class JoinListDto {
  @IsString()
  listId: string;
}

export class CreateTaskWsDto {
  @IsString()
  listId: string;

  @IsString()
  @Length(1, 500)
  title: string;
}

export class UpdateTaskWsDto {
  @IsString()
  taskId: string;

  @IsOptional()
  @IsString()
  @Length(1, 500)
  title?: string;

  @IsOptional()
  @IsBoolean()
  completed?: boolean;

  @IsOptional()
  @IsInt()
  @Min(1)
  baseVersion?: number;
}

export class DeleteTaskWsDto {
  @IsString()
  taskId: string;

  @IsOptional()
  @IsBoolean()
  force?: boolean;
}

export class ReorderTaskWsDto {
  @IsString()
  taskId: string;

  @IsOptional()
  @IsString()
  beforeId?: string;

  @IsOptional()
  @IsString()
  afterId?: string;

  @IsOptional()
  @IsInt()
  @Min(1)
  baseVersion?: number;

  /** Client-generated idempotency key: replaying the same reorder (e.g. after
   *  a missed ack) returns the cached result instead of re-applying it. */
  @IsOptional()
  @IsString()
  @Length(1, 100)
  operationId?: string;
}

export class EditingStartDto {
  @IsString()
  listId: string;

  @IsString()
  taskId: string;
}

export class EditingStopDto {
  @IsString()
  listId: string;

  @IsString()
  taskId: string;
}
