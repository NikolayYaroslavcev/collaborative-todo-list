import { IsString, Length } from 'class-validator';

export class CreateTaskDto {
  @IsString()
  @Length(1, 500)
  title: string;
}
