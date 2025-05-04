import { Injectable } from '@nestjs/common';
import * as mediasoup from 'mediasoup';
import { types as mediasoupTypes } from 'mediasoup';
import { ConfigService } from '@nestjs/config';

interface RoomPassword {
  password: string;
  creatorId: string;
}

interface MediaRoom {
  router: mediasoupTypes.Router;
  producers: Map<string, mediasoupTypes.Producer>;
  consumers: Map<string, mediasoupTypes.Consumer[]>;
}

@Injectable()
export class SfuService {
  private rooms = new Map<string, Map<string, any>>();
  private webRtcServer: mediasoupTypes.WebRtcServer;
  private roomPasswords = new Map<string, RoomPassword>();

  private worker: mediasoupTypes.Worker;
  private mediaRooms = new Map<string, MediaRoom>();

  constructor(private configService: ConfigService) {
    this.initializeMediasoup();
  }

  private async initializeMediasoup() {
    try {
      const rtcMinPort = parseInt(
        this.configService.get('MEDIASOUP_RTC_MIN_PORT') || '40000',
        10,
      );
      const rtcMaxPort = parseInt(
        this.configService.get('MEDIASOUP_RTC_MAX_PORT') || '49999',
        10,
      );

      this.worker = await mediasoup.createWorker({
        logLevel: 'warn',
        logTags: ['info', 'ice', 'dtls', 'rtp', 'srtp', 'rtcp'],
        rtcMinPort,
        rtcMaxPort,
      });

      this.worker.on('died', () => {
        console.error('Mediasoup worker died, exiting in 2 seconds...');
        setTimeout(() => process.exit(1), 2000);
      });
    } catch (error) {
      console.error('Failed to create mediasoup worker:', error);
      throw error;
    }
  }

  async createMediaRoom(roomId: string): Promise<mediasoupTypes.Router> {
    if (this.mediaRooms.has(roomId)) {
      const mediaRoom = this.mediaRooms.get(roomId);
      if (mediaRoom) {
        return mediaRoom.router;
      }
    }

    try {
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

      return router;
    } catch (error) {
      console.error(`Failed to create router for room ${roomId}:`, error);
      throw error;
    }
  }

  async createWebRtcTransport(
    roomId: string,
  ): Promise<mediasoupTypes.WebRtcTransport> {
    const mediaRoom = this.mediaRooms.get(roomId);
    if (!mediaRoom) {
      throw new Error(`Room ${roomId} not found`);
    }

    try {
      const transportOptions = {
        listenIps: [
          {
            ip: this.configService.get('MEDIASOUP_LISTEN_IP') || '0.0.0.0',
            announcedIp:
              this.configService.get('MEDIASOUP_ANNOUNCED_IP') || undefined,
          },
        ],
        enableUdp: true,
        enableTcp: true,
        preferUdp: true,
        initialAvailableOutgoingBitrate: 1000000,
        enableSctp: true,
        numSctpStreams: { OS: 1024, MIS: 1024 },
        maxSctpMessageSize: 262144,
        dtlsParameters: {
          role: 'server',
        },
        handshakeTimeout: 120000,
      };

      const transport =
        await mediaRoom.router.createWebRtcTransport(transportOptions);

      return transport;
    } catch (error) {
      console.error(
        `Failed to create WebRTC transport in room ${roomId}:`,
        error,
      );
      throw error;
    }
  }

  getIceServers() {
    // return [ { urls: 'stun:freestun.net:3478' }, { urls: 'turn:freestun.net:3478', username: 'free', credential: 'free' } ];
    return [];
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
    const mediaRoom = this.mediaRooms.get(roomId);
    if (!mediaRoom) {
      return await this.createMediaRoom(roomId);
    }
    return mediaRoom.router;
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

  closeMediaRoom(roomId: string): void {
    const mediaRoom = this.mediaRooms.get(roomId);
    if (!mediaRoom) return;

    for (const producer of mediaRoom.producers.values()) {
      producer.close();
    }

    for (const consumers of mediaRoom.consumers.values()) {
      for (const consumer of consumers) {
        consumer.close();
      }
    }
    mediaRoom.router.close();
    this.mediaRooms.delete(roomId);
  }

  canConsume(
    roomId: string,
    producerId: string,
    rtpCapabilities: mediasoupTypes.RtpCapabilities,
  ): boolean {
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
}
