import { Controller, Post, Body, HttpException, HttpStatus } from '@nestjs/common';
import { SfuService } from './sfu.service';
import { log } from 'console';

@Controller('sfu')
export class SfuController {
  constructor(private readonly sfuService: SfuService) {}

  @Post('validate-username')
  validateUsername(@Body() data: { roomId: string; username: string }) {
    const { roomId, username } = data;
    if (!username || username.trim().length === 0) {
      throw new HttpException('Username cannot be empty', HttpStatus.BAD_REQUEST);
    }
    
    const isAvailable = this.sfuService.isUsernameAvailable(roomId, username);
    
    if (!isAvailable) {
      return {data: { success: false, message: 'Username already taken in this room' }};
    }
    
    return {data: { success: true, message: 'Username is available' }};
  }

  @Post('verify-room-password')
  verifyRoomPassword(@Body() data: { roomId: string; password: string }) {
    const { roomId, password } = data;
    if (!roomId) {
      throw new HttpException('Missing roomId', HttpStatus.BAD_REQUEST);
    }
    
    // Check if room is locked
    const isLocked = this.sfuService.isRoomLocked(roomId);
    
    if (!isLocked) {
      return { data: { success: true, locked: false, message: 'Room is not locked' }};
    }
    
    // If room is locked, password is required
    if (!password) {
      throw new HttpException('Password required for this room', HttpStatus.FORBIDDEN);
    }
    
    // Verify the password
    const isValid = this.sfuService.verifyRoomPassword(roomId, password);
    
    if (isValid) {
      return { data: { success: true, locked: true, valid: true, message: 'Password valid' }};
    } else {
      throw new HttpException('Invalid password', HttpStatus.FORBIDDEN);
    }
  }
  
  @Post('check-room-status')
  checkRoomStatus(@Body() data: { roomId: string }) {
    const { roomId } = data;
    if (!roomId) {
      throw new HttpException('Missing roomId', HttpStatus.BAD_REQUEST);
    }
    
    const isLocked = this.sfuService.isRoomLocked(roomId);
    
    return { 
      data: { 
        success: true, 
        locked: isLocked, 
        message: isLocked ? 'Room is password-protected' : 'Room is open'
      }
    };
  }
} 