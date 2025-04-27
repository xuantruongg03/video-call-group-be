import { Injectable } from '@nestjs/common';
import * as mediasoup from 'mediasoup';
import { types as mediasoupTypes } from 'mediasoup';
import { ConfigService } from '@nestjs/config';

interface RoomPassword {
  password: string;
  creatorId: string; // To track who created/locked the room
}

interface MediaRoom {
  router: mediasoupTypes.Router;
  producers: Map<string, mediasoupTypes.Producer>; // streamId -> Producer
  consumers: Map<string, mediasoupTypes.Consumer[]>; // streamId -> Consumer[]
}

@Injectable()
export class SfuService {
  // This will match the rooms structure from the gateway
  private rooms = new Map<string, Map<string, any>>();
  private webRtcServer: mediasoupTypes.WebRtcServer;  
  
  // Store room passwords
  private roomPasswords = new Map<string, RoomPassword>();
  
  // Store mediasoup workers and routers
  private worker: mediasoupTypes.Worker;
  private mediaRooms = new Map<string, MediaRoom>();
  private dtlsCert ;
  
  constructor(private configService: ConfigService) {
    this.initializeMediasoup();
  }
  
  private async initializeMediasoup() {
    try {
      // Kiểm tra và tạo biến môi trường nếu chưa có
      const rtcMinPort = parseInt(this.configService.get('MEDIASOUP_RTC_MIN_PORT') || '40000', 10);
      const rtcMaxPort = parseInt(this.configService.get('MEDIASOUP_RTC_MAX_PORT') || '49999', 10);
      
      // Khởi tạo mediasoup worker
      this.worker = await mediasoup.createWorker({
        logLevel: 'warn',
        logTags: ['info', 'ice', 'dtls', 'rtp', 'srtp', 'rtcp'],
        rtcMinPort,
        rtcMaxPort,
      });
      
      // Xử lý khi worker died
      this.worker.on('died', () => {
        console.error('Mediasoup worker died, exiting in 2 seconds...');
        setTimeout(() => process.exit(1), 2000);
      });
    } catch (error) {
      console.error('Failed to create mediasoup worker:', error);
      throw error;
    }
  }
  
  // Tạo router cho phòng
  async createMediaRoom(roomId: string): Promise<mediasoupTypes.Router> {
    if (this.mediaRooms.has(roomId)) {
      const mediaRoom = this.mediaRooms.get(roomId);
      if (mediaRoom) {
        return mediaRoom.router;
      }
    }
    
    try {
      // Tạo mediasoup router
      const router = await this.worker.createRouter({
        mediaCodecs: [
          {
            kind: 'audio',
            mimeType: 'audio/opus',
            clockRate: 48000,
            channels: 2,
          },
          {
            kind: 'video',
            mimeType: 'video/VP8',
            clockRate: 90000,
            parameters: {
              'x-google-start-bitrate': 1000,
            },
          },
          {
            kind: 'video',
            mimeType: 'video/H264',
            clockRate: 90000,
            parameters: {
              'packetization-mode': 1,
              'profile-level-id': '42e01f',
              'level-asymmetry-allowed': 1,
              'x-google-start-bitrate': 1000,
            },
          },
        ],
      });
      
      this.mediaRooms.set(roomId, {
        router,
        producers: new Map(),
        consumers: new Map(),
      });
      
      console.log(`MediaRoom created for room ${roomId}`);
      
      return router;
    } catch (error) {
      console.error(`Failed to create router for room ${roomId}:`, error);
      throw error;
    }
  }
  
  // Tạo WebRTC transport cho một client
  async createWebRtcTransport(roomId: string): Promise<mediasoupTypes.WebRtcTransport> {
    const mediaRoom = this.mediaRooms.get(roomId);
    if (!mediaRoom) {
      throw new Error(`Room ${roomId} not found`);
    }

    try {
      // Khai báo transport options với WebRtcServer
      const transportOptions = {
        listenIps: [
          {
            ip: this.configService.get('MEDIASOUP_LISTEN_IP') || '0.0.0.0',
            announcedIp: this.configService.get('MEDIASOUP_ANNOUNCED_IP') || undefined
          }
        ],
        enableUdp: true,
        enableTcp: true,
        preferUdp: true,
        initialAvailableOutgoingBitrate: 1000000,
        enableSctp: true,
        numSctpStreams: { OS: 1024, MIS: 1024 },
        maxSctpMessageSize: 262144,
        dtlsParameters: {
          role: 'server', // Chỉ định rõ vai trò
        },
        handshakeTimeout: 120000, // 2 phút
      };
  
      const transport = await mediaRoom.router.createWebRtcTransport(transportOptions);
      transport.on('dtlsstatechange', (dtlsState) => {
        console.log(`Transport ${transport.id} DTLS state: ${dtlsState}`);
        
        if (dtlsState === 'failed') {
          console.error(`DTLS handshake failed for transport ${transport.id}`);
        }
      });
      
      transport.on('icestatechange', (iceState) => {
        console.log(`Transport ${transport.id} ICE state: ${iceState}`);
      });
      console.log('Transport created with id:', transport.id);
      
      return transport;
    } catch (error) {
      console.error(`Failed to create WebRTC transport in room ${roomId}:`, error);
      throw error;
    }
  }
  
  // Cập nhật phương thức getIceServers
  getIceServers() {
    // return [ { urls: 'stun:freestun.net:3478' }, { urls: 'turn:freestun.net:3478', username: 'free', credential: 'free' } ];
    return []
  }
  
  // Lưu producer
  saveProducer(roomId: string, streamId: string, producer: mediasoupTypes.Producer): void {
    const mediaRoom = this.mediaRooms.get(roomId);
    if (!mediaRoom) return;
    
    mediaRoom.producers.set(streamId, producer);
  }
  
  // Lấy producer
  getProducer(roomId: string, streamId: string): mediasoupTypes.Producer | undefined {
    return this.mediaRooms.get(roomId)?.producers.get(streamId);
  }
  
  // Lưu consumer
  saveConsumer(roomId: string, streamId: string, consumer: mediasoupTypes.Consumer): void {
    const mediaRoom = this.mediaRooms.get(roomId);
    if (!mediaRoom) return;
    
    if (!mediaRoom.consumers.has(streamId)) {
      mediaRoom.consumers.set(streamId, []);
    }
    
    mediaRoom.consumers.get(streamId)?.push(consumer);
  }
  
  // Xóa producer
  removeProducer(roomId: string, streamId: string): void {
    const mediaRoom = this.mediaRooms.get(roomId);
    if (!mediaRoom) return;
    
    mediaRoom.producers.delete(streamId);
    
    // Đóng tất cả consumer liên quan
    if (mediaRoom.consumers.has(streamId)) {
      for (const consumer of mediaRoom.consumers.get(streamId) || []) {
        consumer.close();
      }
      mediaRoom.consumers.delete(streamId);
    }
  }
  
  // Đóng room
  closeMediaRoom(roomId: string): void {
    const mediaRoom = this.mediaRooms.get(roomId);
    if (!mediaRoom) return;
    
    // Đóng tất cả producer và consumer
    for (const producer of mediaRoom.producers.values()) {
      producer.close();
    }
    
    for (const consumers of mediaRoom.consumers.values()) {
      for (const consumer of consumers) {
        consumer.close();
      }
    }
    
    // Đóng router
    mediaRoom.router.close();
    
    // Xóa phòng
    this.mediaRooms.delete(roomId);
    
    console.log(`MediaRoom ${roomId} closed`);
  }
  
  // Kiểm tra hỗ trợ RTP capabilities
  canConsume(roomId: string, producerId: string, rtpCapabilities: mediasoupTypes.RtpCapabilities): boolean {
    const mediaRoom = this.mediaRooms.get(roomId);
    if (!mediaRoom) return false;
    
    try {
      return mediaRoom.router.canConsume({
        producerId,
        rtpCapabilities,
      });
    } catch (error) {
      console.error('canConsume() error:', error);
      return false;
    }
  }

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