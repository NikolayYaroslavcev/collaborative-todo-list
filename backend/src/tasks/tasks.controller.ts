import {
  Body,
  Controller,
  Delete,
  Get,
  Param,
  Patch,
  Post,
  Query,
  UseGuards,
} from '@nestjs/common';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { CurrentUser } from '../auth/current-user.decorator';
import { AuthenticatedUser } from '../auth/types';
import { TasksService } from './tasks.service';
import { CreateTaskDto } from './dto/create-task.dto';
import { UpdateTaskDto } from './dto/update-task.dto';

@UseGuards(JwtAuthGuard)
@Controller()
export class TasksController {
  constructor(private readonly tasksService: TasksService) {}

  @Get('lists/:listId/tasks')
  findAll(@CurrentUser() user: AuthenticatedUser, @Param('listId') listId: string) {
    return this.tasksService.listTasks(listId, user.id);
  }

  @Post('lists/:listId/tasks')
  create(
    @CurrentUser() user: AuthenticatedUser,
    @Param('listId') listId: string,
    @Body() dto: CreateTaskDto,
  ) {
    return this.tasksService.createTask(listId, user.id, dto.title);
  }

  @Patch('tasks/:id')
  update(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id') id: string,
    @Body() dto: UpdateTaskDto,
  ) {
    return this.tasksService.updateTask(id, user.id, dto);
  }

  @Delete('tasks/:id')
  remove(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id') id: string,
    @Query('force') force?: string,
  ) {
    return this.tasksService.deleteTask(id, user.id, force === 'true');
  }
}
