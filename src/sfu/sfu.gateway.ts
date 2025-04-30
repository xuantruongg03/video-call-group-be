import { Injectable } from '@nestjs/common';
import {
  ConnectedSocket,
  MessageBody,
  OnGatewayInit,
  SubscribeMessage,
  WebSocketGateway,
  WebSocketServer,
} from '@nestjs/websockets';
import { types as mediasoupTypes } from 'mediasoup';
import { Server, Socket } from 'socket.io';
import { SfuService } from './sfu.service';
import * as fs from 'fs';
import { log } from 'console';

interface Participant {
  socketId: string;
  peerId: string;
  rtpCapabilities?: mediasoupTypes.RtpCapabilities;
  transports: Map<string, mediasoupTypes.WebRtcTransport>; // transportId -> transport
  producers: Map<string, mediasoupTypes.Producer>; // producerId -> producer
  consumers: Map<string, mediasoupTypes.Consumer>; // consumerId -> consumer
  isCreator: boolean;
  timeArrive: Date;
}

interface Stream {
  streamId: string;
  publisherId: string; // peerId of publisher
  producerId: string; // mediasoup producer id
  metadata: any; // resolution, audio/video status, etc.
  rtpParameters: mediasoupTypes.RtpParameters;
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
  path: '/socket.io/',
  serveClient: false,
  secure: true,
  ssl: {
    key: fs.readFileSync("secrets/private-key.pem"),
    cert: fs.readFileSync("secrets/public-certificate.pem"),
  },
})
@Injectable()
export class SfuGateway implements OnGatewayInit {
  @WebSocketServer() io: Server;

  // Map<roomId, Map<username, Participant>>
  private rooms = new Map<string, Map<string, Participant>>();

  // Map<streamId, Stream>
  private streams = new Map<string, Stream>();
  private producerToStream = new Map<string, Stream>();

  private roomMessages = new Map<string, ChatMessage[]>();

  constructor(private readonly sfuService: SfuService) { }

  afterInit() {
    console.log('SFU gateway initialized');
  }

  handleConnection(client: Socket) {
    console.log('Client connected to SFU: ', client.id);
  }

  @SubscribeMessage('sfu:join')
  async handleJoin(
    @ConnectedSocket() client: Socket,
    @MessageBody() data: { roomId: string; peerId: string; password?: string },
  ) {
    const roomId = data.roomId;
    const peerId = data.peerId;

    // Check if room is password protected
    if (this.sfuService.isRoomLocked(roomId)) {
      // If room is locked, password is required
      if (!data.password) {
        client.emit('sfu:error', {
          message: 'This room is password protected',
          code: 'ROOM_PASSWORD_REQUIRED',
        });
        return;
      }

      // Verify the password
      const isValid = this.sfuService.verifyRoomPassword(roomId, data.password);

      if (!isValid) {
        console.log('Invalid room password');
        client.emit('sfu:error', {
          message: 'Invalid room password',
          code: 'INVALID_ROOM_PASSWORD',
        });
        return;
      }
    }

    client.join(roomId);

    // Initialize room if needed
    if (!this.rooms.has(roomId)) {
      this.rooms.set(roomId, new Map());
      await this.sfuService.createMediaRoom(roomId);
    }

    const room = this.rooms.get(roomId);
    const isCreator = this.rooms.get(roomId)?.size === 0;

    // Double-check username is not already in use (safety measure)
    if (room && room.has(peerId)) {
      client.emit('sfu:error', {
        message: 'Username already in use',
        code: 'USERNAME_TAKEN',
      });
      return;
    }

    // Create participant object
    const participant: Participant = {
      socketId: client.id,
      peerId: peerId,
      transports: new Map(),
      producers: new Map(),
      consumers: new Map(),
      isCreator: isCreator,
      timeArrive: new Date(),
    };

    this.rooms.get(roomId)?.set(peerId, participant);

    // Update service with latest room data
    this.sfuService.updateRooms(this.rooms);

    // Send list of available streams in the room to the new participant
    const availableStreams = Array.from(this.streams.values())
      .filter((stream) => {
        const publisher = this.getParticipantByPeerId(stream.publisherId);
        return publisher && this.getParticipantRoom(publisher) === roomId;
      })
      .map((stream) => ({
        streamId: stream.streamId,
        publisherId: stream.publisherId,
        metadata: stream.metadata,
      }));

    // Gửi router RTP capabilities đến client
    try {
      const router = await this.sfuService.createMediaRoom(roomId);
      client.emit('sfu:router-capabilities', {
        routerRtpCapabilities: router.rtpCapabilities,
      });
    } catch (error) {
      console.error('Failed to get router capabilities:', error);
      client.emit('sfu:error', {
        message: 'Failed to get router capabilities',
        code: 'ROUTER_ERROR',
      });
      return;
    }

    client.emit('sfu:streams', availableStreams);

    client.to(roomId).emit('sfu:new-peer-join', {
      peerId: participant.peerId,
      isCreator: participant.isCreator,
      timeArrive: participant.timeArrive
    });
    console.log(`Participant ${peerId} joined room ${roomId}`);
  }

  @SubscribeMessage('sfu:my-speaking')
  handleMySpeaking(
    @ConnectedSocket() client: Socket,
    @MessageBody() data: { roomId: string; peerId: string },
  ) {
    const roomId = data.roomId;
    const peerId = data.peerId;
    const participant = this.getParticipantByPeerId(peerId);
    if (!participant) return;
    const room = this.getParticipantRoom(participant);
    if (!room) return;
    client.to(room).emit('sfu:user-speaking', { peerId });
  }

  @SubscribeMessage('sfu:stop-speaking')
  handleStopSpeaking(
    @ConnectedSocket() client: Socket,
    @MessageBody() data: { roomId: string; peerId: string },
  ) {
    const roomId = data.roomId;
    const peerId = data.peerId;
    const participant = this.getParticipantByPeerId(peerId);
    if (!participant) return;
    const room = this.getParticipantRoom(participant);
    if (!room) return;
    client.to(room).emit('sfu:user-stopped-speaking', { peerId });
  }

  @SubscribeMessage('sfu:connect-transport')
  async handleConnectTransport(
    @ConnectedSocket() client: Socket,
    @MessageBody()
    data: {
      transportId: string;
      dtlsParameters: mediasoupTypes.DtlsParameters;
    },
  ) {
    console.log(`Transport ${data.transportId} connected`);
    try {
      const participant = this.getParticipantBySocketId(client.id);
      if (!participant) {
        throw new Error('Participant not found');
      }

      const transport = participant.transports.get(data.transportId);
      if (!transport) {
        throw new Error(`Transport ${data.transportId} not found`);
      }

      // Check if transport is already connected
      if (transport.appData && transport.appData.connected) {
        console.log(`Transport ${data.transportId} is already connected, ignoring request`);
        client.emit('sfu:transport-connected', { transportId: data.transportId });
        return;
      }

      if (!data.dtlsParameters) {
        throw new Error('DTLS parameters missing or null');
      }

      console.log(`Connecting transport ${data.transportId} with DTLS role: ${data.dtlsParameters.role}`);
      await transport.connect({ dtlsParameters: data.dtlsParameters });

      // Mark transport as connected
      transport.appData = {
        ...transport.appData,
        connected: true
      };

      client.emit('sfu:transport-connected', { transportId: data.transportId });
      console.log(`Transport ${data.transportId} connected successfully`);
    } catch (error) {
      console.error('Connect transport error:', error);
      client.emit('sfu:error', {
        message: 'Failed to connect transport',
        code: 'TRANSPORT_CONNECT_ERROR',
        error: error.message,
      });
    }
  }

  @SubscribeMessage("sfu:remove-user")
  async handleRemoveUser(
    @ConnectedSocket() client: Socket,
    @MessageBody() data: { roomId: string, participantId: string },
  ) {
    console.log(data.participantId);

    //Xoá người dùng khỏi phòng
    const room = this.rooms.get(data.roomId);
    if (!room) {
      client.emit('sfu:error', {
        message: 'Không thấy phòng',
        code: 'ROOM_NOT_FOUND',
      });
      return;
    }


    //Xoá tất cả stream của người dùng
    for (const [streamId, stream] of Array.from(this.streams.entries())) {
      if (stream.publisherId === data.participantId) {
        // Xóa producer từ service
        this.sfuService.removeProducer(data.roomId, streamId);

        // Xóa stream
        this.streams.delete(streamId);

        // Thông báo cho các client khác
        client.to(data.roomId).emit('sfu:stream-removed', {
          streamId,
          publisherId: data.participantId,
        });
      }
    }

    //Xoá người dùng khỏi phòng
    room.delete(data.participantId);
    client.emit('sfu:user-removed', {
      peerId: data.participantId,
    });
    //thông báo cho các người dùng trong phòng
    client.to(data.roomId).emit('sfu:user-removed', {
      peerId: data.participantId,
    });
  }

  @SubscribeMessage("sfu:get-users")
  async handleGetUserInRoom(
    @ConnectedSocket() client: Socket,
    @MessageBody() data: { roomId: string },
  ) {

    // Lấy danh sách người dùng trong phòng
    const room = this.rooms.get(data.roomId);
    if (!room) {
      // client.emit('sfu:error', {
      //   message: 'Room not found',
      //   code: 'ROOM_NOT_FOUND',
      // });
      return;
    }

    // Lấy danh sách người dùng trong phòng
    const users = Array.from(room.values()).map((participant) => ({
      peerId: participant.peerId,
      isCreator: participant.isCreator,
      timeArrive: participant.timeArrive
    }));

    // Gửi danh sách người dùng cho client
    client.emit('sfu:users', users);
  }

  @SubscribeMessage('sfu:get-rtpcapabilities')
  async handleGetRouterRtpCapabilities(
    @ConnectedSocket() client: Socket,
    @MessageBody() data: { roomId: string },
  ) {
    try {
      const router = await this.sfuService.createMediaRoom(data.roomId);
      client.emit('sfu:router-capabilities', {
        routerRtpCapabilities: router.rtpCapabilities,
      });
    } catch (error) {
      console.error('Failed to get router capabilities:', error);
      client.emit('sfu:error', {
        message: 'Failed to get router capabilities',
        code: 'ROUTER_ERROR',
      });
    }
  }

  @SubscribeMessage('sfu:create-transport')
  async handleCreateWebRtcTransport(
    @ConnectedSocket() client: Socket,
    @MessageBody()
    data: {
      roomId: string;
      isProducer: boolean;
    },
  ) {
    const participant = this.getParticipantBySocketId(client.id);
    if (!participant) {
      client.emit('sfu:error', {
        message: 'Participant not found',
        code: 'PARTICIPANT_NOT_FOUND',
      });
      return;
    }

    try {
      // Tạo transport không cần ice servers cho server
      const transport = await this.sfuService.createWebRtcTransport(
        data.roomId,
      );

      transport.appData = {
        ...(transport.appData || {}),
        connected: false,
        isProducer: data.isProducer,
      };

      // Lưu transport vào participant
      participant.transports.set(transport.id, transport);
      // Lắng nghe event khi transport đóng
      transport.on('routerclose', () => {
        console.log(`Transport ${transport.id} closed because router closed`);
        transport.close();
        participant.transports.delete(transport.id);
      });

      // Nhưng vẫn gửi ice servers về client
      const transportInfo = {
        id: transport.id,
        iceParameters: transport.iceParameters,
        iceCandidates: transport.iceCandidates,
        dtlsParameters: transport.dtlsParameters,
        isProducer: data.isProducer,
        iceServers: this.sfuService.getIceServers(),
      };

      client.emit('sfu:transport-created', transportInfo);

    } catch (error) {
      console.error('Create WebRTC transport error:', error);
      client.emit('sfu:error', {
        message: 'Failed to create transport',
        code: 'TRANSPORT_CREATE_ERROR',
        error: error.message,
      });
    }
  }

  @SubscribeMessage('sfu:produce')
  async handleProduce(
    @ConnectedSocket() client: Socket,
    @MessageBody()
    data: {
      transportId: string;
      kind: mediasoupTypes.MediaKind;
      rtpParameters: mediasoupTypes.RtpParameters;
      metadata: any;
    },
  ) {

    const participant = this.getParticipantBySocketId(client.id);
    if (!participant) {
      client.emit('sfu:error', {
        message: 'Participant not found',
        code: 'PARTICIPANT_NOT_FOUND',
      });
      return;
    }

    const roomId = this.getParticipantRoom(participant);
    if (!roomId) {
      client.emit('sfu:error', {
        message: 'Room not found',
        code: 'ROOM_NOT_FOUND',
      });
      return;
    }

    const transport = participant.transports.get(data.transportId);
    if (!transport) {
      client.emit('sfu:error', {
        message: 'Transport not found',
        code: 'TRANSPORT_NOT_FOUND',
      });
      return;
    }

    try {
      // Tạo producer
      const producer = await transport.produce({
        kind: data.kind,
        rtpParameters: data.rtpParameters,
      });

      // Lưu producer vào participant
      participant.producers.set(producer.id, producer);

      // Tạo streamId
      const streamId = `${participant.peerId}-${data.metadata.type}-${Date.now()}`;

      // Lưu stream
      const stream: Stream = {
        streamId,
        publisherId: participant.peerId,
        producerId: producer.id,
        metadata: data.metadata,
        rtpParameters: data.rtpParameters,
      };

      this.streams.set(streamId, stream);
      this.producerToStream.set(producer.id, stream);

      // Lưu producer vào service
      this.sfuService.saveProducer(roomId, streamId, producer);

      // Xử lý khi producer đóng
      producer.on('transportclose', () => {
        console.log(`Producer ${producer.id} closed because transport closed`);
        this.sfuService.removeProducer(roomId, streamId);
        participant.producers.delete(producer.id);
        this.streams.delete(streamId);
      });

      // Thông báo producer đã tạo và streamId cho client
      client.emit('sfu:producer-created', {
        producerId: producer.id,
        streamId,
      });

      // Thông báo cho các client khác về stream mới
      client.to(roomId).emit('sfu:stream-added', {
        streamId,
        publisherId: participant.peerId,
        metadata: data.metadata,
        rtpParameters: data.rtpParameters,
      });

      console.log(`Producer ${producer.id} created for stream ${streamId}`);
    } catch (error) {
      console.error('Produce error:', error);
      client.emit('sfu:error', {
        message: 'Failed to produce',
        code: 'PRODUCE_ERROR',
        error: error.message,
      });
    }
  }

  getStreamByProducerId(producerId: string): Stream | undefined {
    return this.producerToStream.get(producerId);
  }

  @SubscribeMessage('sfu:set-rtp-capabilities')
  handleSetRtpCapabilities(
    @ConnectedSocket() client: Socket,
    @MessageBody() data: { rtpCapabilities: mediasoupTypes.RtpCapabilities },
  ) {
    const participant = this.getParticipantBySocketId(client.id);
    if (!participant) {
      client.emit('sfu:error', {
        message: 'Participant not found',
        code: 'PARTICIPANT_NOT_FOUND',
      });
      return;
    }

    participant.rtpCapabilities = data.rtpCapabilities;
    client.emit('sfu:rtp-capabilities-set');
  }

  @SubscribeMessage('sfu:consume')
  async handleConsume(
    @ConnectedSocket() client: Socket,
    @MessageBody()
    data: {
      streamId: string;
      transportId: string;
    },
  ) {
    const participant = this.getParticipantBySocketId(client.id);
    if (!participant) {
      client.emit('sfu:error', {
        message: 'Participant not found',
        code: 'PARTICIPANT_NOT_FOUND',
      });
      return;
    }

    const roomId = this.getParticipantRoom(participant);
    if (!roomId) {
      client.emit('sfu:error', {
        message: 'Room not found',
        code: 'ROOM_NOT_FOUND',
      });
      return;
    }

    const stream = this.streams.get(data.streamId);
    if (!stream) {
      client.emit('sfu:error', {
        message: 'Stream not found',
        code: 'STREAM_NOT_FOUND',
      });
      return;
    }

    const transport = participant.transports.get(data.transportId);
    if (!transport) {
      client.emit('sfu:error', {
        message: 'Transport not found',
        code: 'TRANSPORT_NOT_FOUND',
      });
      return;
    }

    // Kiểm tra RTP capabilities
    if (!participant.rtpCapabilities) {
      client.emit('sfu:error', {
        message: 'No RTP capabilities set',
        code: 'NO_RTP_CAPABILITIES',
      });
      return;
    }

    // Lấy producer
    const producer = this.sfuService.getProducer(roomId, data.streamId);
    if (!producer) {
      client.emit('sfu:error', {
        message: 'Producer not found',
        code: 'PRODUCER_NOT_FOUND',
      });
      return;
    }

    // Kiểm tra xem có thể consume không
    if (
      !this.sfuService.canConsume(
        roomId,
        producer.id,
        participant.rtpCapabilities,
      )
    ) {
      client.emit('sfu:error', {
        message: 'Không thể tiêu thụ producer này',
        code: 'CANNOT_CONSUME',
      });
      return;
    }

    try {
      // Tạo consumer
      const consumer = await transport.consume({
        producerId: producer.id,
        rtpCapabilities: participant.rtpCapabilities,
        paused: true,
      });

      // Lưu consumer vào participant
      participant.consumers.set(consumer.id, consumer);

      // Lưu consumer vào service
      this.sfuService.saveConsumer(roomId, data.streamId, consumer);

      // Xử lý khi consumer đóng
      consumer.on('transportclose', () => {
        participant.consumers.delete(consumer.id);
      });

      consumer.on('producerclose', () => {
        participant.consumers.delete(consumer.id);
        client.emit('sfu:consumer-closed', {
          consumerId: consumer.id,
          streamId: data.streamId,
        });
      });

      // Gửi consumer parameter về client
      client.emit('sfu:consumer-created', {
        consumerId: consumer.id,
        streamId: data.streamId,
        producerId: producer.id,
        kind: consumer.kind,
        rtpParameters: consumer.rtpParameters,
      });
    } catch (error) {
      console.error('Consume error:', error);
      client.emit('sfu:error', {
        message: 'Lỗi tiêu thụ',
        code: 'CONSUME_ERROR',
        error: error.message,
      });
    }
  }

  @SubscribeMessage('sfu:resume-consumer')
  async handleResumeConsumer(
    @ConnectedSocket() client: Socket,
    @MessageBody() data: { consumerId: string },
  ) {
    const participant = this.getParticipantBySocketId(client.id);
    if (!participant) {
      client.emit('sfu:error', {
        message: 'Người dùng không tồn tại',
        code: 'PARTICIPANT_NOT_FOUND',
      });
      return;
    }

    const consumer = participant.consumers.get(data.consumerId);
    if (!consumer) {
      client.emit('sfu:error', {
        message: 'Consumer không tồn tại',
        code: 'CONSUMER_NOT_FOUND',
      });
      return;
    }

    try {
      await consumer.resume();
      client.emit('sfu:consumer-resumed', { consumerId: data.consumerId });
    } catch (error) {
      console.error('Resume consumer error:', error);
      client.emit('sfu:error', {
        message: 'Lỗi khôi phục consumer',
        code: 'RESUME_CONSUMER_ERROR',
        error: error.message,
      });
    }
  }

  @SubscribeMessage('sfu:unpublish')
  async handleUnpublish(
    @ConnectedSocket() client: Socket,
    @MessageBody() data: { streamId: string },
  ) {

    const participant = this.getParticipantBySocketId(client.id);
    if (!participant) return;

    const roomId = this.getParticipantRoom(participant);
    if (!roomId) return;

    // Lấy stream
    const stream = this.streams.get(data.streamId);
    if (!stream) return;

    // Kiểm tra xem stream có thuộc về participant hay không
    if (stream.publisherId !== participant.peerId) {
      client.emit('sfu:error', {
        message: 'Bạn không sở hữu stream này',
        code: 'NOT_STREAM_OWNER',
      });
      return;
    }

    // Lấy producer
    const producer = participant.producers.get(stream.producerId);
    if (producer) {
      // Đóng producer
      producer.close();
      participant.producers.delete(stream.producerId);
    }

    // Xóa producer từ service
    this.sfuService.removeProducer(roomId, data.streamId);

    // Xóa stream
    this.streams.delete(data.streamId);

    // Thông báo cho các client khác
    client.to(roomId).emit('sfu:stream-removed', {
      streamId: data.streamId,
      publisherId: participant.peerId,

    });
  }

  @SubscribeMessage('sfu:get-streams')
  handleGetStreams(
    @ConnectedSocket() client: Socket,
    @MessageBody() data: { roomId: string },
  ) {
    const roomId = data.roomId;
    const participant = this.getParticipantBySocketId(client.id);
    if (!participant) {
      client.emit('sfu:error', {
        message: 'Người dùng không tồn tại',
        code: 'PARTICIPANT_NOT_FOUND',
      });
      return;
    }

    //Tìm tất cả stream có sẵn trong phòng
    const availableStreams = Array.from(this.streams.values())
      .filter((stream) => {
        const publisher = this.getParticipantByPeerId(stream.publisherId);
        return (
          publisher &&
          this.getParticipantRoom(publisher) === roomId &&
          stream.publisherId !== participant.peerId
        );
      })
      .map((stream) => ({
        streamId: stream.streamId,
        publisherId: stream.publisherId,
        metadata: stream.metadata,
      }));
    client.emit('sfu:streams', availableStreams);
  }

  @SubscribeMessage('sfu:update')
  handleUpdateStream(
    @ConnectedSocket() client: Socket,
    @MessageBody() data: { streamId: string; metadata: any },
  ) {
    const participant = this.getParticipantBySocketId(client.id);

    if (!participant) return;

    const roomId = this.getParticipantRoom(participant);
    if (!roomId) {
      client.emit('sfu:error', {
        message: 'Phòng không tồn tại',
        code: 'ROOM_NOT_FOUND',
      });
      return;
    }

    const stream = this.getStreamByProducerId(data.streamId);

    if (!stream || stream.publisherId !== participant.peerId) {
      client.emit('sfu:error', {
        message: 'Không thể cập nhật stream bạn không sở hữu',
        streamId: data.streamId,
      });
      return;
    }

    // Cập nhật metadata
    if (data.metadata.video !== undefined) {
      stream.metadata.video = data.metadata.video;
    }
    if (data.metadata.audio !== undefined) {
      stream.metadata.audio = data.metadata.audio;
    }

    // Thông báo cho các client khác về sự thay đổi
    client.to(roomId).emit('sfu:stream-updated', {
      streamId: data.streamId,
      publisherId: participant.peerId,
      metadata: stream.metadata,
    });

  }
  @SubscribeMessage('sfu:leave-room')
  async handleLeaveRoom(@ConnectedSocket() client: Socket, @MessageBody() data: { roomId: string }) {


    const participant = this.getParticipantBySocketId(client.id);
    if (!participant) return;

    const room = this.rooms.get(data.roomId);
    if (!room) return;
    // Đóng tất cả transport
    for (const transport of participant.transports.values()) {
      transport.close();
    }

    // Xóa tất cả stream của người dùng
    for (const [streamId, stream] of Array.from(this.streams.entries())) {
      if (stream.publisherId === participant.peerId) {
        // Xóa producer từ service
        this.sfuService.removeProducer(data.roomId, streamId);

        // Xóa stream
        this.streams.delete(streamId);

        // Thông báo cho các client khác
        client.to(data.roomId).emit('sfu:stream-removed', {
          streamId,
          publisherId: participant.peerId,
        });

        client.to(data.roomId).emit('sfu:remove-user', {
          roomId: data.roomId,
          participantId: participant.peerId,
        });
      }
    }

    // Xóa participant khỏi phòng
    room.delete(participant.peerId);

    //participant nào ở trong phòng lâu nhất thì đặt làm creator
    const users = Array.from(room.values());
    const longestUser = users.reduce((max, current) => {
      return current.timeArrive > max.timeArrive ? current : max;
    }, users[0]);
    if (longestUser) {
      // Cập nhật creator
      longestUser.isCreator = true;
    }


    // Thông báo cho mọi người về việc rời đi
    client.to(data.roomId).emit('sfu:peer-left', { peerId: participant.peerId });

    // Dọn dẹp phòng trống
    if (room.size === 0) {
      // Đóng mediaRoom
      this.sfuService.closeMediaRoom(data.roomId);

      // Xóa phòng
      this.rooms.delete(data.roomId);
      console.log(`Room ${data.roomId} is empty, deleted`);
    }

    // Cập nhật service với dữ liệu phòng mới nhất
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
    if (!this.roomMessages.has(roomId)) {
      this.roomMessages.set(roomId, []);
    }
    client.emit('chat:history', this.roomMessages.get(roomId));
  }

  @SubscribeMessage('chat:message')
  handleChatMessage(
    @ConnectedSocket() client: Socket,
    @MessageBody()
    data: {
      roomId: string;
      message: {
        sender: string;
        senderName: string;
        text: string;
      };
    },
  ) {
    const roomId = data.roomId;
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
    @MessageBody()
    data: { roomId: string; password: string; },
  ) {

    const participant = this.getParticipantBySocketId(client.id);
    if (!participant) return;

    console.log(participant.peerId);
    console.log(participant.isCreator);

    //Kiểm tra xem participant có phải là creator của phòng hay không
    if (!participant.isCreator) {
      client.emit('sfu:error', {
        message: 'Bạn không phải là người tạo phòng này',
        code: 'NOT_CREATOR',
      });
      return;
    }

    //Kiểm tra xem phòng có tồn tại hay không
    const roomId = this.getParticipantRoom(participant);
    if (!roomId || roomId !== data.roomId) {
      client.emit('sfu:error', {
        message: 'Bạn không ở trong phòng này',
        code: 'NOT_IN_ROOM',
      });
      return;
    }

    //Khóa phòng
    const success = this.sfuService.lockRoom(
      roomId,
      data.password,
      participant.peerId,
    );

    //Thông báo cho tất cả người dùng trong phòng phòng đã được khóa
    if (success) {
      this.io.to(roomId).emit('sfu:room-locked', {
        locked: true,
        lockedBy: participant.peerId,
      });
    } else {
      client.emit('sfu:error', {
        message: 'Lỗi khóa phòng',
        code: 'FAILED_TO_LOCK_ROOM',
      });
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
        message: 'Bạn không ở trong phòng này',
        code: 'NOT_IN_ROOM',
      });
      return;
    }

    //Kiểm tra xem participant có phải là creator của phòng hay không
    if (!participant.isCreator) {
      client.emit('sfu:error', {
        message: 'Bạn không phải là người tạo phòng này',
        code: 'NOT_CREATOR',
      });
    }

    const success = this.sfuService.unlockRoom(roomId, participant.peerId);

    if (success) {
      //Thông báo cho tất cả người dùng trong phòng phòng đã được khóa
      this.io.to(roomId).emit('sfu:room-locked', {
        locked: false,
        unlockedBy: participant.peerId,
      });
    } else {
      client.emit('sfu:error', {
        message: 'Lỗi mở khóa phòng',
        code: 'FAILED_TO_UNLOCK_ROOM',
      });
    }
  }
}
