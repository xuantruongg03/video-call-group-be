import { Injectable, OnModuleDestroy } from '@nestjs/common';
import * as mediasoup from 'mediasoup';
import { types as mediasoupTypes } from 'mediasoup';
import { ConfigService } from '@nestjs/config';
import { WorkerPoolService } from 'src/worker-pool/worker-pool.service';
import { EventEmitter2 } from 'eventemitter2';

interface RoomPassword {
  password: string;
  creatorId: string;
}

interface MediaRoom {
  router: mediasoupTypes.Router | null;
  producers: Map<string, mediasoupTypes.Producer>;
  consumers: Map<string, mediasoupTypes.Consumer[]>;
  workerId?: string;
}

@Injectable()
export class SfuService implements OnModuleDestroy {
  private rooms = new Map<string, Map<string, any>>();
  private webRtcServer: mediasoupTypes.WebRtcServer;
  private webRtcServerId: string;
  private roomPasswords = new Map<string, RoomPassword>();

  private worker: mediasoupTypes.Worker;
  private mediaRooms = new Map<string, MediaRoom>();
  private readonly mediaRouters = new Map<string, mediasoupTypes.Router>();

  constructor(
    private configService: ConfigService,
    private readonly workerPool: WorkerPoolService,
    private readonly eventEmitter: EventEmitter2,
  ) {
    this.initializeMediasoup();
    this.eventEmitter.on('worker.replaced', this.handleWorkerReplaced.bind(this));
  }

  private async initializeMediasoup() {
    try {
      const rtcMinPort = parseInt(
        this.configService.get('MEDIASOUP_RTC_MIN_PORT') || '10000',
        10,
      );
      const rtcMaxPort = parseInt(
        this.configService.get('MEDIASOUP_RTC_MAX_PORT') || '25999',
        10,
      );

      // Tạo worker đầu tiên để host WebRTC server
      this.worker = await mediasoup.createWorker({
        logLevel: 'warn',
        logTags: ['info', 'ice', 'dtls', 'rtp', 'srtp', 'rtcp'],
        rtcMinPort,
        rtcMaxPort,
      });

      // Tạo WebRTC server duy nhất
      this.webRtcServer = await this.worker.createWebRtcServer({
        listenInfos: [
          {
            protocol: 'udp',
            ip: this.configService.get('MEDIASOUP_LISTEN_IP') || '0.0.0.0',
            announcedIp: this.configService.get('MEDIASOUP_ANNOUNCED_IP'),
            port: parseInt(this.configService.get('MEDIASOUP_PORT') || '55555') + 5000
          },
          {
            protocol: 'tcp',
            ip: this.configService.get('MEDIASOUP_LISTEN_IP') || '0.0.0.0',
            announcedIp: this.configService.get('MEDIASOUP_ANNOUNCED_IP'),
            port: parseInt(this.configService.get('MEDIASOUP_PORT') || '55555') + 5000
          }
        ]
      });

      // Lưu ID của WebRTC server để sử dụng với các router khác
      this.webRtcServerId = this.webRtcServer.id;
      
      console.log(`Created WebRTC server with ID: ${this.webRtcServerId}`);

      // Chia sẻ WebRtcServer với WorkerPoolService
      this.workerPool.setSharedWebRtcServer(this.webRtcServer);

      this.worker.on('died', () => {
        console.error('Main mediasoup worker died (hosting WebRTC server), exiting in 2 seconds...');
        setTimeout(() => process.exit(1), 2000);
      });
    } catch (error) {
      console.error('Failed to create mediasoup worker or WebRTC server:', error);
      throw error;
    }
  }

  async onModuleDestroy() {
    await this.workerPool.closeAll();
    if (this.worker) {
      await this.worker.close();
    }
  }

  async createMediaRoom(roomId: string): Promise<mediasoupTypes.Router> {
    if (this.mediaRouters.has(roomId)) {
      return this.mediaRouters.get(roomId)!;
    }

    // Lấy worker theo roomId để đảm bảo cùng một room luôn ở trên cùng một worker
    const worker = this.workerPool.getWorkerByRoomId(roomId);
    
    // Lưu thông tin room
    this.mediaRooms.set(roomId, {
      router: null,
      producers: new Map(),
      consumers: new Map(),
      workerId: worker.pid.toString()
    });

    const router = await worker.createRouter({
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
          mimeType: 'video/VP9',
          clockRate: 90000,
          parameters: {
            'profile-id': 2,
            'x-google-start-bitrate': 1000,
          },
        },
        {
          kind: 'video',
          mimeType: 'video/h264',
          clockRate: 90000,
          parameters: {
            'packetization-mode': 1,
            'profile-level-id': '4d0032',
            'level-asymmetry-allowed': 1,
            'x-google-start-bitrate': 1000,
          },
        },
        {
          kind: 'video',
          mimeType: 'video/h264',
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

    this.mediaRouters.set(roomId, router);
    const mediaRoom = this.mediaRooms.get(roomId)!;
    mediaRoom.router = router;
    console.log(`Created router for room ${roomId} on worker ${worker.pid}`);

    return router;
  }

  async createWebRtcTransport(roomId: string): Promise<mediasoupTypes.WebRtcTransport> {
    const mediaRoom = this.mediaRooms.get(roomId);
    if (!mediaRoom || !mediaRoom.router) {
      throw new Error(`Room ${roomId} not found`);
    }

    try {
      // Get the correct WebRTC server for this worker
      const workerId = mediaRoom.workerId || '';
      const webRtcServer = this.workerPool.getWebRtcServerForWorker(workerId);
      
      if (!webRtcServer) {
        console.warn(`No WebRTC server found for worker ${workerId}, falling back to direct transport`);
        // Fallback to direct transport if no WebRTC server is available
        const transportOptions: mediasoupTypes.WebRtcTransportOptions = {
          listenIps: [ 
            {
              ip: this.configService.get('MEDIASOUP_LISTEN_IP') || '0.0.0.0',
              announcedIp: this.configService.get('MEDIASOUP_ANNOUNCED_IP'),
            }
          ],
          enableUdp: true,
          enableTcp: true,
          preferUdp: true,
          initialAvailableOutgoingBitrate: 1000000,
          enableSctp: true,
          numSctpStreams: { OS: 1024, MIS: 1024 },
          maxSctpMessageSize: 262144,
        };
        
        console.log(`Creating direct transport with options:`, JSON.stringify(transportOptions));
        return await mediaRoom.router.createWebRtcTransport(transportOptions);
      }
      
      // Use the WebRTC server for this worker
      const transportOptions: mediasoupTypes.WebRtcTransportOptions = {
        webRtcServer,
        enableUdp: true,
        enableTcp: true,
        preferUdp: true,
        initialAvailableOutgoingBitrate: 1000000,
        enableSctp: true,
        numSctpStreams: { OS: 1024, MIS: 1024 },
        maxSctpMessageSize: 262144,
      };

      console.log(`Creating transport with WebRTC server ID ${webRtcServer.id}`);
      const transport = await mediaRoom.router.createWebRtcTransport(transportOptions);
      console.log(`Transport created with ID: ${transport.id}`);
      
      return transport;
    } catch (error) {
      console.error(`Failed to create WebRTC transport in room ${roomId}:`, error);
      throw error;
    }
  }

  async getIceServers() {
    const useIceServers = this.configService.get('USE_ICE_SERVERS') || false;
    if (!useIceServers) {
      console.log('ICE servers disabled, returning empty array');
      return [];
    }
    
    const iceServers = [
      { urls: this.configService.get('STUN_SERVER_URL') },
      {
        urls: [
          this.configService.get('TURN_SERVER_URL'),
        ],
        username: this.configService.get('TURN_SERVER_USERNAME'),
        credential: this.configService.get('TURN_SERVER_PASSWORD'),
      },
    ];
    
    console.log('Returning ICE servers:', JSON.stringify(iceServers));
    return iceServers;
  }

  saveProducer(
    roomId: string,
    streamId: string,
    producer: mediasoupTypes.Producer,
  ): void {
    const mediaRoom = this.mediaRooms.get(roomId);
    if (!mediaRoom) return;

    mediaRoom.producers.set(streamId, producer);
  }

  getProducer(
    roomId: string,
    streamId: string,
  ): mediasoupTypes.Producer | undefined {
    return this.mediaRooms.get(roomId)?.producers.get(streamId);
  }

  async getMediaRouter(roomId: string): Promise<mediasoupTypes.Router> {
    if (!this.mediaRouters.has(roomId)) {
      return this.createMediaRoom(roomId);
    }
    return this.mediaRouters.get(roomId)!;
  }

  saveConsumer(
    roomId: string,
    streamId: string,
    consumer: mediasoupTypes.Consumer,
  ): void {
    const mediaRoom = this.mediaRooms.get(roomId);
    if (!mediaRoom) return;

    if (!mediaRoom.consumers.has(streamId)) {
      mediaRoom.consumers.set(streamId, []);
    }

    mediaRoom.consumers.get(streamId)?.push(consumer);
  }

  removeProducer(roomId: string, streamId: string): void {
    const mediaRoom = this.mediaRooms.get(roomId);
    if (!mediaRoom) return;

    mediaRoom.producers.delete(streamId);

    if (mediaRoom.consumers.has(streamId)) {
      for (const consumer of mediaRoom.consumers.get(streamId) || []) {
        consumer.close();
      }
      mediaRoom.consumers.delete(streamId);
    }
  }

  async closeMediaRoom(roomId: string): Promise<void> {
    const router = this.mediaRouters.get(roomId);
    if (router) {
      await router.close();
      this.mediaRouters.delete(roomId);
      this.mediaRooms.delete(roomId);
      console.log(`Closed router for room ${roomId}`);
    }
  }

  canConsume(
    roomId: string,
    producerId: string,
    rtpCapabilities: mediasoupTypes.RtpCapabilities,
  ): boolean {
    const mediaRoom = this.mediaRooms.get(roomId);
    if (!mediaRoom || !mediaRoom.router) return false;

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

  isUsernameAvailable(roomId: string, username: string): boolean {
    if (!this.rooms.has(roomId)) {
      return true;
    }

    const roomParticipants = this.rooms.get(roomId);

    return !Array.from(roomParticipants?.keys() || []).includes(username);
  }

  updateRooms(rooms: Map<string, Map<string, any>>) {
    this.rooms = rooms;
  }

  getRoom(roomId: string) {
    return this.rooms.get(roomId);
  }

  lockRoom(roomId: string, password: string, creatorId: string): boolean {
    this.roomPasswords.set(roomId, { password, creatorId });
    return true;
  }

  unlockRoom(roomId: string, creatorId: string): boolean {
    const roomPassword = this.roomPasswords.get(roomId);

    if (roomPassword && roomPassword.creatorId === creatorId) {
      this.roomPasswords.delete(roomId);
      return true;
    }

    return false;
  }

  isRoomLocked(roomId: string): boolean {
    return this.roomPasswords.has(roomId);
  }

  verifyRoomPassword(roomId: string, password: string): boolean {
    const roomPassword = this.roomPasswords.get(roomId);

    if (!roomPassword) {
      return true;
    }

    return roomPassword.password === password;
  }

  isCreatorOfRoom(peerId: string, roomId: string): boolean {
    const room = this.rooms.get(roomId);
    if (!room) return false;
    const participant = room.get(peerId);
    return participant?.isCreator || false;
  }

  getParticipantInRoom(peerId: string, roomId: string) {
    const room = this.rooms.get(roomId);
    if (!room) return null;
    return room.get(peerId) || null;
  }

  // Thêm phương thức để lấy thông tin về worker của một room
  getWorkerInfoForRoom(roomId: string): { workerId: string } | null {
    const mediaRoom = this.mediaRooms.get(roomId);
    if (!mediaRoom) return null;
    
    return { workerId: mediaRoom.workerId || 'unknown' };
  }

  // Thêm phương thức để lấy thông tin về tất cả worker
  async getWorkersStatus(): Promise<any[]> {
    const workers = this.workerPool.getAllWorkers();
    const status: any[] = [];
    
    for (const worker of workers) {
      const usage = await worker.getResourceUsage();
      const workerRooms = Array.from(this.mediaRooms.entries())
        .filter(([_, mediaRoom]) => mediaRoom.workerId === worker.pid.toString())
        .map(([roomId, _]) => roomId);
        
      status.push({
        workerId: worker.pid,
        usage,
        rooms: workerRooms
      });
    }
    
    return status;
  }

  private async handleWorkerReplaced(data: { oldWorkerId: string, newWorkerId: string }) {
    // Tìm các phòng bị ảnh hưởng
    const affectedRooms = Array.from(this.mediaRooms.entries())
      .filter(([_, mediaRoom]) => mediaRoom.workerId === data.oldWorkerId)
      .map(([roomId, _]) => roomId);
    
    console.log(`Worker ${data.oldWorkerId} was replaced with ${data.newWorkerId}. Affected rooms: ${affectedRooms.join(', ')}`);
    
    // Tạo lại router cho các phòng bị ảnh hưởng
    for (const roomId of affectedRooms) {
      // Xóa router cũ
      this.mediaRouters.delete(roomId);
      
      // Cập nhật workerId mới - router sẽ được tạo sau
      if (this.mediaRooms.has(roomId)) {
        const mediaRoom = this.mediaRooms.get(roomId)!;
        mediaRoom.router = null;
        mediaRoom.workerId = data.newWorkerId;
      }
      
      // Tạo router mới (sẽ được tạo khi cần)
      console.log(`Router for room ${roomId} will be recreated on next access`);
      
      // Thông báo cho các client trong phòng
      this.eventEmitter.emit('room.router-recreated', { roomId });
    }
  }
}
