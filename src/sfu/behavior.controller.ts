import { Controller, Post, Get, Body, Param, Res, HttpStatus } from '@nestjs/common';
import { BehaviorService } from './behavior.service';
import { BehaviorLogRequest } from '../interfaces/behavior';
import { Response } from 'express';
import { SfuService } from './sfu.service';

@Controller('behavior')
export class BehaviorController {
  constructor(
    private readonly behaviorService: BehaviorService,
    private readonly sfuService: SfuService,
  ) {}

  @Post('log')
  saveBehaviorLog(@Body() logRequest: BehaviorLogRequest) {
    const { userId, roomId, events } = logRequest;
    this.behaviorService.saveUserBehavior(userId, roomId, events);
    return { success: true };
  }

  @Get('logs/:roomId/:requesterId/:userId')
  async getUserLogs(
    @Param('roomId') roomId: string,
    @Param('requesterId') requesterId: string,
    @Param('userId') userId: string,
    @Res() res: Response,
  ) {
    const isCreator = this.sfuService.isCreatorOfRoom(requesterId, roomId);
    
    if (!isCreator) {
      return res.status(HttpStatus.FORBIDDEN).json({
        success: false,
        message: 'Chỉ người tổ chức mới có quyền tải xuống log người dùng',
      });
    }

    try {
      const buffer = await this.behaviorService.generateUserLogExcel(roomId, userId);
      
      res.set({
        'Content-Type': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
        'Content-Disposition': `attachment; filename="user_behavior_log_${userId}.xlsx"`,
        'Content-Length': buffer.length,
      });
      
      return res.send(buffer);
    } catch (error) {
      return res.status(HttpStatus.NOT_FOUND).json({
        success: false,
        message: error.message || 'Không thể tạo file log',
      });
    }
  }
} 