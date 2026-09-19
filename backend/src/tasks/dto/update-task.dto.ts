import { IsBoolean, IsInt, IsOptional, IsString, Length, Min } from 'class-validator';

export class UpdateTaskDto {
  @IsOptional()
  @IsString()
  @Length(1, 500)
  title?: string;

  @IsOptional()
  @IsBoolean()
  completed?: boolean;

  /** The task version the client last saw. Used for optimistic-concurrency conflict detection. */
  @IsOptional()
  @IsInt()
  @Min(1)
  baseVersion?: number;
}
