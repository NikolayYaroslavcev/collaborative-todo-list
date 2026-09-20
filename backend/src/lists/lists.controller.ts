import { Body, Controller, Delete, Get, Param, Post, Query, UseGuards } from '@nestjs/common';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { CurrentUser } from '../auth/current-user.decorator';
import { AuthenticatedUser } from '../auth/types';
import { ListsService } from './lists.service';
import { CreateListDto } from './dto/create-list.dto';
import { CreateInviteDto } from './dto/create-invite.dto';
import { ListListsQueryDto } from './dto/list-lists-query.dto';

@UseGuards(JwtAuthGuard)
@Controller()
export class ListsController {
  constructor(private readonly listsService: ListsService) {}

  @Get('lists')
  findAll(@CurrentUser() user: AuthenticatedUser, @Query() query: ListListsQueryDto) {
    return this.listsService.findAllForUser(user.id, query.page, query.pageSize);
  }

  @Post('lists')
  create(@CurrentUser() user: AuthenticatedUser, @Body() dto: CreateListDto) {
    return this.listsService.createList(user.id, dto.title);
  }

  @Get('lists/:id')
  getOne(@CurrentUser() user: AuthenticatedUser, @Param('id') id: string) {
    return this.listsService.getListSnapshot(id, user.id);
  }

  @Delete('lists/:id')
  remove(@CurrentUser() user: AuthenticatedUser, @Param('id') id: string) {
    return this.listsService.deleteList(id, user.id);
  }

  @Post('lists/:id/invite')
  invite(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id') id: string,
    @Body() dto: CreateInviteDto,
  ) {
    return this.listsService.createInvite(id, user.id, dto.role, dto.expiresInHours);
  }

  @Post('invites/:token/accept')
  accept(@CurrentUser() user: AuthenticatedUser, @Param('token') token: string) {
    return this.listsService.acceptInvite(token, user.id);
  }
}
