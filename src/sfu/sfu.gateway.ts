import {
  WebSocketGateway,
  SubscribeMessage,
  MessageBody,
  ConnectedSocket,
  WebSocketServer,
  OnGatewayInit,
} from '@nestjs/websockets';
import { Server } from 'socket.io';
import { Socket } from 'socket.io';
import { Injectable } from '@nestjs/common';
import { SfuService } from './sfu.service';
import { UnauthorizedException } from '@nestjs/common';
import { log } from 'console';

interface Participant {
  socketId: string;
  peerId: string;
  streams: Map<string, any>; // streamId -> stream metadata
  subscriptions: Set<string>; // streamIds they're subscribed to
}

interface Stream {
  streamId: string;
  publisherId: string; // peerId of publisher
  metadata: any; // resolution, audio/video status, etc.
}

interface ChatMessage {
  id: string;
  roomId: string;
  sender: string;
  senderName: string;
  text: string;
  timestamp: string;
}

@WebSocketGateway(3002, {
  transports: ['websocket'],
  cors: {
    origin: '*',
    allowedHeaders: ['Content-Type'],
    methods: ['GET', 'POST'],
    credentials: true,
  },
})
@Injectable()
export class SfuGateway implements OnGatewayInit {
  @WebSocketServer() io: Server;

  // Map<roomId, Map<username, Participant>>
  private rooms = new Map<string, Map<string, Participant>>();
  
  // Map<streamId, Stream>
  private streams = new Map<string, Stream>();

  private roomMessages = new Map<string, ChatMessage[]>();

  constructor(private readonly sfuService: SfuService) {}

  afterInit() {
    console.log('SFU gateway initialized');
  }

  handleConnection(client: Socket) {
    console.log('Client connected to SFU: ', client.id);
  }

  @SubscribeMessage('sfu:join')
  handleJoin(
    @ConnectedSocket() client: Socket,
    @MessageBody() data: { roomId: string; peerId: string; password?: string },
  ) {
    const roomId = data.roomId;
    const peerId = data.peerId; // This is now the username
    console.log(data);
    
    // Check if room is password protected
    if (this.sfuService.isRoomLocked(roomId)) {
      // If room is locked, password is required
      if (!data.password) {
        client.emit('sfu:error', { 
          message: 'This room is password protected', 
          code: 'ROOM_PASSWORD_REQUIRED' 
        });
        return;
      }
      
      // Verify the password
      const isValid = this.sfuService.verifyRoomPassword(roomId, data.password);
      
      if (!isValid) {
        console.log('Invalid room password');
        client.emit('sfu:error', { 
          message: 'Invalid room password', 
          code: 'INVALID_ROOM_PASSWORD' 
        });
        return;
      }
    }
    
    console.log(`Client ${client.id} (Username: ${peerId}) joined SFU room ${roomId}`);
    client.join(roomId);
    
    // Initialize room if needed
    if (!this.rooms.has(roomId)) {
      this.rooms.set(roomId, new Map());
    }
    
    // Double-check username is not already in use (safety measure)
    const room = this.rooms.get(roomId);
    if (room && room.has(peerId)) {
      client.emit('sfu:error', { 
        message: 'Username already in use', 
        code: 'USERNAME_TAKEN' 
      });
      return;
    }
    
    // Create participant object
    const participant: Participant = {
      socketId: client.id,
      peerId: peerId, // Username as peerId
      streams: new Map(),
      subscriptions: new Set(),
    };
    
    this.rooms.get(roomId)?.set(peerId, participant);
    
    // Update service with latest room data
    this.sfuService.updateRooms(this.rooms);

    // Send list of available streams in the room to the new participant
    const availableStreams = Array.from(this.streams.values())
      .filter(stream => {
        const publisher = this.getParticipantByPeerId(stream.publisherId);
        return publisher && this.getParticipantRoom(publisher) === roomId;
      })
      .map(stream => ({
        streamId: stream.streamId,
        publisherId: stream.publisherId,
        metadata: stream.metadata,
      }));
    
    client.emit('sfu:streams', availableStreams);
    
    // Notify others in the room about the new participant
    client.to(roomId).emit('sfu:peer-joined', { peerId });
  }

  @SubscribeMessage('sfu:publish')
  handlePublish(
    @ConnectedSocket() client: Socket,
    @MessageBody() data: { streamId: string; metadata: any },
  ) {
    const participant = this.getParticipantBySocketId(client.id);
    if (!participant) return;
    
    const roomId = this.getParticipantRoom(participant);
    if (!roomId) return;
    
    const stream: Stream = {
      streamId: data.streamId,
      publisherId: participant.peerId,
      metadata: data.metadata,
    };
    
    // Register the stream
    this.streams.set(data.streamId, stream);
    participant.streams.set(data.streamId, data.metadata);
    
    // Notify others in the room about the new stream
    client.to(roomId).emit('sfu:stream-added', {
      streamId: data.streamId,
      publisherId: participant.peerId,
      metadata: data.metadata,
    });
    
    console.log(`Peer ${participant.peerId} published stream ${data.streamId} in room ${roomId}`);
  }

  @SubscribeMessage('sfu:subscribe')
  handleSubscribe(
    @ConnectedSocket() client: Socket,
    @MessageBody() data: { streamId: string },
  ) {
    const participant = this.getParticipantBySocketId(client.id);
    if (!participant) return;
    
    const stream = this.streams.get(data.streamId);
    if (!stream) {
      client.emit('sfu:error', { message: 'Stream not found', streamId: data.streamId });
      return;
    }
    
    // Add subscription
    participant.subscriptions.add(data.streamId);
    
    // Forward the subscription request to the publisher
    const publisher = this.getParticipantByPeerId(stream.publisherId);
    if (publisher) {
      this.io.to(publisher.socketId).emit('sfu:subscriber', {
        streamId: data.streamId,
        subscriberId: participant.peerId,
      });
    }
    
    console.log(`Peer ${participant.peerId} subscribed to stream ${data.streamId}`);
  }

  @SubscribeMessage('sfu:signal')
  handleSignal(
    @ConnectedSocket() client: Socket,
    @MessageBody() data: { targetId: string; streamId: string; signal: any },
  ) {
    const sender = this.getParticipantBySocketId(client.id);
    if (!sender) return;
    
    const target = this.getParticipantByPeerId(data.targetId);
    if (!target) return;
    
    // Forward the signaling data
    this.io.to(target.socketId).emit('sfu:signal', {
      streamId: data.streamId,
      peerId: sender.peerId,
      signal: data.signal,
    });
  }

  @SubscribeMessage('sfu:unpublish')
  handleUnpublish(
    @ConnectedSocket() client: Socket,
    @MessageBody() data: { streamId: string },
  ) {
    const participant = this.getParticipantBySocketId(client.id);
    if (!participant) return;
    
    const roomId = this.getParticipantRoom(participant);
    if (!roomId) return;
    
    // Remove the stream
    participant.streams.delete(data.streamId);
    const stream = this.streams.get(data.streamId);
    
    if (stream) {
      this.streams.delete(data.streamId);
      
      // Notify others in the room
      client.to(roomId).emit('sfu:stream-removed', {
        streamId: data.streamId,
        publisherId: participant.peerId,
      });
      
      console.log(`Peer ${participant.peerId} unpublished stream ${data.streamId}`);
    }
  }

  @SubscribeMessage('sfu:update')
  handleUpdateStream(
    @ConnectedSocket() client: Socket,
    @MessageBody() data: { streamId: string; metadata: any },
  ) {
    const participant = this.getParticipantBySocketId(client.id);
    if (!participant) return;
    
    const roomId = this.getParticipantRoom(participant);
    if (!roomId) return;
    
    const stream = this.streams.get(data.streamId);
    if (!stream || stream.publisherId !== participant.peerId) {
      client.emit('sfu:error', { 
        message: 'Cannot update stream you do not own', 
        streamId: data.streamId 
      });
      return;
    }
    
    // Cập nhật metadata
    stream.metadata = data.metadata;
    participant.streams.set(data.streamId, data.metadata);
    
    // Thông báo cho các client khác về sự thay đổi
    client.to(roomId).emit('sfu:stream-updated', {
      streamId: data.streamId,
      publisherId: participant.peerId,
      metadata: data.metadata,
    });
    
    console.log(`Stream ${data.streamId} updated with metadata:`, data.metadata);
  }

  handleDisconnect(client: Socket) {
    const participant = this.getParticipantBySocketId(client.id);
    if (!participant) return;
    
    const roomId = this.getParticipantRoom(participant);
    if (!roomId) return;
    
    const room = this.rooms.get(roomId);
    if (!room) return;
    
    // Remove all participant's streams
    participant.streams.forEach((_, streamId) => {
      this.streams.delete(streamId);
      
      // Notify others about stream removal
      client.to(roomId).emit('sfu:stream-removed', {
        streamId,
        publisherId: participant.peerId,
      });
    });
    
    // Remove participant from room
    room.delete(participant.peerId);
    
    // Notify others about participant leaving
    client.to(roomId).emit('sfu:peer-left', { peerId: participant.peerId });
    
    console.log(`Peer ${participant.peerId} disconnected from room ${roomId}`);
    
    // Clean up empty room
    if (room.size === 0) {
      this.rooms.delete(roomId);
      console.log(`Room ${roomId} is empty, deleted`);
      
    }
    
    // Update service with latest room data after disconnection
    this.sfuService.updateRooms(this.rooms);
  }

  // Helper methods
  private getParticipantBySocketId(socketId: string): Participant | null {
    for (const [_, room] of this.rooms) {
      for (const [_, participant] of room) {
        if (participant.socketId === socketId) {
          return participant;
        }
      }
    }
    return null;
  }

  private getParticipantByPeerId(peerId: string): Participant | null {
    for (const [_, room] of this.rooms) {
      const participant = room.get(peerId);
      if (participant) return participant;
    }
    return null;
  }

  private getParticipantRoom(participant: Participant): string | null {
    for (const [roomId, room] of this.rooms) {
      if (room.has(participant.peerId)) {
        return roomId;
      }
    }
    return null;
  }

  @SubscribeMessage('chat:join')
  handleChatJoin(
    @ConnectedSocket() client: Socket,
    @MessageBody() data: { roomId: string; userName: string },
  ) {
    const roomId = data.roomId;
    
    console.log(`User ${data.userName} joined chat room: ${roomId}`);
    
    // Đảm bảo danh sách tin nhắn cho phòng đã được khởi tạo
    if (!this.roomMessages.has(roomId)) {
      this.roomMessages.set(roomId, []);
    }
    
    // Gửi lịch sử tin nhắn cho người dùng mới
    client.emit('chat:history', this.roomMessages.get(roomId));
  }

  @SubscribeMessage('chat:message')
  handleChatMessage(
    @ConnectedSocket() client: Socket,
    @MessageBody() data: { 
      roomId: string; 
      message: { 
        sender: string; 
        senderName: string; 
        text: string; 
      } 
    },
  ) {
    const roomId = data.roomId;
    
    // Tạo tin nhắn mới với ID và thời gian
    const newMessage: ChatMessage = {
      id: Date.now().toString(),
      roomId,
      sender: data.message.sender,
      senderName: data.message.senderName,
      text: data.message.text,
      timestamp: new Date().toISOString(),
    };
    
    // Lưu tin nhắn vào lịch sử
    if (this.roomMessages.has(roomId)) {
      this.roomMessages.get(roomId)?.push(newMessage);
    } else {
      this.roomMessages.set(roomId, [newMessage]);
    }
    
    // Giới hạn kích thước lịch sử (chỉ lưu 100 tin nhắn gần nhất)
    const messages = this.roomMessages.get(roomId);
    if (messages && messages.length > 100) {
      this.roomMessages.set(roomId, messages.slice(-100));
    }
    
    // Phát tin nhắn đến tất cả người dùng trong phòng
    this.io.to(roomId).emit('chat:message', newMessage);
    
    console.log(`Chat message in room ${roomId} from ${data.message.senderName}: ${data.message.text}`);
  }

  @SubscribeMessage('chat:leave')
  handleChatLeave(
    @ConnectedSocket() client: Socket,
    @MessageBody() data: { roomId: string },
  ) {
    console.log(`User left chat room: ${data.roomId}`);
    // Không cần xử lý đặc biệt khi người dùng rời khỏi chat
    // Tin nhắn vẫn được lưu trong roomMessages
  }

  @SubscribeMessage('sfu:lock-room')
  handleLockRoom(
    @ConnectedSocket() client: Socket,
    @MessageBody() data: { roomId: string; password: string },
  ) {
    const participant = this.getParticipantBySocketId(client.id);
    if (!participant) return;
    
    const roomId = this.getParticipantRoom(participant);
    if (!roomId || roomId !== data.roomId) {
      client.emit('sfu:error', { 
        message: 'You are not in this room', 
        code: 'NOT_IN_ROOM' 
      });
      return;
    }
    
    const success = this.sfuService.lockRoom(roomId, data.password, participant.peerId);
    
    if (success) {
      // Notify all users in the room that it's now locked
      this.io.to(roomId).emit('sfu:room-locked', { 
        locked: true,
        lockedBy: participant.peerId
      });
      
      client.emit('sfu:lock-success', { 
        roomId,
        message: 'Room locked successfully' 
      });
      console.log('Room locked successfully');
    }
  }

  @SubscribeMessage('sfu:unlock-room')
  handleUnlockRoom(
    @ConnectedSocket() client: Socket,
    @MessageBody() data: { roomId: string },
  ) {
    const participant = this.getParticipantBySocketId(client.id);
    if (!participant) return;
    
    const roomId = this.getParticipantRoom(participant);
    if (!roomId || roomId !== data.roomId) {
      client.emit('sfu:error', { 
        message: 'You are not in this room', 
        code: 'NOT_IN_ROOM' 
      });
      return;
    }
    
    const success = this.sfuService.unlockRoom(roomId, participant.peerId);
    
    if (success) {
      // Notify all users in the room that it's now unlocked
      this.io.to(roomId).emit('sfu:room-locked', { 
        locked: false,
        unlockedBy: participant.peerId
      });
      
      client.emit('sfu:unlock-success', { 
        roomId, 
        message: 'Room unlocked successfully' 
      });
    } else {
      client.emit('sfu:error', { 
        message: 'Failed to unlock room. You are not the room creator.', 
        code: 'NOT_ROOM_CREATOR' 
      });
    }
  }
} 