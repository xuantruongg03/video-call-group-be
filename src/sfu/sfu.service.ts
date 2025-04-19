import { Injectable } from '@nestjs/common';

interface RoomPassword {
  password: string;
  creatorId: string; // To track who created/locked the room
}

@Injectable()
export class SfuService {
  // This will match the rooms structure from the gateway
  private rooms = new Map<string, Map<string, any>>();
  
  // Store room passwords
  private roomPasswords = new Map<string, RoomPassword>();
  
  // Check if a username is available in a specific room
  isUsernameAvailable(roomId: string, username: string): boolean {
    if (!this.rooms.has(roomId)) {
      return true; // If room doesn't exist, username is available
    }
    
    const roomParticipants = this.rooms.get(roomId);
    
    // Check if username is already used as a peerId in this room
    return !Array.from(roomParticipants?.keys() || []).includes(username);
  }
  
  // Update the room structure (called from the gateway)
  updateRooms(rooms: Map<string, Map<string, any>>) {
    this.rooms = rooms;
  }

  getRoom(roomId: string) {
    return this.rooms.get(roomId);
  }
  
  // Lock a room with a password
  lockRoom(roomId: string, password: string, creatorId: string): boolean {
    // Store the password for this room
    this.roomPasswords.set(roomId, { password, creatorId });
    return true;
  }
  
  // Unlock a room
  unlockRoom(roomId: string, creatorId: string): boolean {
    const roomPassword = this.roomPasswords.get(roomId);
    
    // Only the creator can unlock the room
    if (roomPassword && roomPassword.creatorId === creatorId) {
      this.roomPasswords.delete(roomId);
      return true;
    }
    
    return false;
  }
  
  // Check if a room is locked
  isRoomLocked(roomId: string): boolean {
    return this.roomPasswords.has(roomId);
  }
  
  // Verify room password
  verifyRoomPassword(roomId: string, password: string): boolean {
    const roomPassword = this.roomPasswords.get(roomId);
    
    if (!roomPassword) {
      return true; // Room isn't locked, so any password is fine
    }
    
    return roomPassword.password === password;
  }
} 