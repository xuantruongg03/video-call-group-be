import { Injectable } from '@nestjs/common';
import { SfuService } from '../sfu/sfu.service';
import { MouseUser, PositionMouse } from 'src/interfaces/whiteboard.inteface';

@Injectable()
export class WhiteboardService {
  private whiteboardData = new Map<string, any>();
  private positionMouse = new Map<string, Map<string, MouseUser>>();
  private whiteboardPermissions = new Map<string, string[]>();

  constructor(private readonly sfuService: SfuService) {}

  updateWhiteboardData(roomId: string, data: any) {
    this.whiteboardData.set(roomId, data);
    return data;
  }

  getWhiteboardData(roomId: string) {
    return this.whiteboardData.get(roomId) || null;
  }

  clearWhiteboard(roomId: string) {
    this.whiteboardData.set(roomId, null);
    return true;
  }

  updatePermissions(roomId: string, allowedUsers: string[]) {
    this.whiteboardPermissions.set(roomId, allowedUsers);
    return allowedUsers;
  }

  getPermissions(roomId: string) {
    return this.whiteboardPermissions.get(roomId) || [];
  }

  canUserDraw(roomId: string, peerId: string): boolean {
    if (this.sfuService.isCreatorOfRoom(peerId, roomId)) {
      return true;
    }
    
    const permissions = this.whiteboardPermissions.get(roomId) || [];
    return permissions.includes(peerId);
  }

  updateUserPointer(roomId: string, peerId: string, position: PositionMouse) {
    if (!this.positionMouse.has(roomId)) {
      this.positionMouse.set(roomId, new Map());
    }
    
    const pointersInRoom = this.positionMouse.get(roomId);
    if (!pointersInRoom) return [];
    pointersInRoom.set(peerId, { position, peerId });
    
    return this.getPointers(roomId);
  }

  getPointers(roomId: string) {
    const pointersMap = this.positionMouse.get(roomId);
    if (!pointersMap) return [];
    
    return Array.from(pointersMap.values());
  }

  removeUserPointer(roomId: string, peerId: string) {
    const pointersMap = this.positionMouse.get(roomId);
    if (pointersMap) {
      pointersMap.delete(peerId);
    }
    return this.getPointers(roomId);
  }
}