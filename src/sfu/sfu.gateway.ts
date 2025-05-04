import { Injectable } from '@nestjs/common';
import {
  ConnectedSocket,
  MessageBody,
  OnGatewayInit,
  SubscribeMessage,
  WebSocketGateway,
  WebSocketServer,
} from '@nestjs/websockets';
import * as fs from 'fs';
import { types as mediasoupTypes } from 'mediasoup';
import { Server, Socket } from 'socket.io';
import { WhiteboardService } from '../whiteboard/whiteboard.service';
import { SfuService } from './sfu.service';
import { MouseUser, PositionMouse } from 'src/interfaces/whiteboard.inteface';

interface Participant {
  socketId: string;
  peerId: string;
  rtpCapabilities?: mediasoupTypes.RtpCapabilities;
  transports: Map<string, mediasoupTypes.WebRtcTransport>;
  producers: Map<string, mediasoupTypes.Producer>;
  consumers: Map<string, mediasoupTypes.Consumer>;
  isCreator: boolean;
  timeArrive: Date;
}

interface Stream {
  streamId: string;
  publisherId: string;
  producerId: string;
  metadata: any;
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
    key: fs.readFileSync('secrets/private-key.pem'),
    cert: fs.readFileSync('secrets/public-certificate.pem'),
  },
})
@Injectable()
export class SfuGateway implements OnGatewayInit {
  @WebSocketServer() io: Server;
  private rooms = new Map<string, Map<string, Participant>>();
  private streams = new Map<string, Stream>();
  private producerToStream = new Map<string, Stream>();
  private roomMessages = new Map<string, ChatMessage[]>();

  constructor(
    private readonly sfuService: SfuService,
    private readonly whiteboardService: WhiteboardService,
  ) {}

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

    // Tìm các stream "presence" và gửi sự kiện presence riêng
    const presenceStreams = availableStreams.filter(
      (stream) =>
        stream.streamId.includes('presence') ||
        (stream.metadata && stream.metadata.type === 'presence'),
    );

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

    // Gửi các sự kiện presence cho người dùng mới
    presenceStreams.forEach((stream) => {
      setTimeout(() => {
        client.emit('sfu:presence', {
          peerId: stream.publisherId,
          metadata: stream.metadata,
        });
      }, 500);
    });

    client.to(roomId).emit('sfu:new-peer-join', {
      peerId: participant.peerId,
      isCreator: participant.isCreator,
      timeArrive: participant.timeArrive,
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
        client.emit('sfu:transport-connected', {
          transportId: data.transportId,
        });
        return;
      }

      if (!data.dtlsParameters) {
        throw new Error('DTLS parameters missing or null');
      }

      await transport.connect({ dtlsParameters: data.dtlsParameters });

      // Mark transport as connected
      transport.appData = {
        ...transport.appData,
        connected: true,
      };

      client.emit('sfu:transport-connected', { transportId: data.transportId });
    } catch (error) {
      console.error('Connect transport error:', error);
      client.emit('sfu:error', {
        message: 'Failed to connect transport',
        code: 'TRANSPORT_CONNECT_ERROR',
        error: error.message,
      });
    }
  }

  @SubscribeMessage('sfu:remove-user')
  async handleRemoveUser(
    @ConnectedSocket() client: Socket,
    @MessageBody() data: { roomId: string; participantId: string },
  ) {
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

  @SubscribeMessage('sfu:get-users')
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
      timeArrive: participant.timeArrive,
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

      console.log(
        `[Produce] Producer created: ${producer.id}, kind: ${producer.kind}`,
      );

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

      console.log(
        `Producer ${producer.id} created for stream ${streamId}, broadcasting to room ${roomId}`,
      );
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
    console.log(`Consume request for stream: ${data.streamId}`);
    const participant = this.getParticipantBySocketId(client.id);
    if (!participant) {
      client.emit('sfu:error', {
        message: 'Participant not found',
        code: 'PARTICIPANT_NOT_FOUND',
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

    const roomId = this.getParticipantRoom(participant);
    if (!roomId) {
      client.emit('sfu:error', {
        message: 'Room not found',
        code: 'ROOM_NOT_FOUND',
      });
      return;
    }

    // Find stream
    const stream = this.streams.get(data.streamId);
    if (!stream) {
      // Log detailed information for debugging
      console.log(`Stream not found: ${data.streamId}`);
      console.log(`Available streams: ${[...this.streams.keys()].join(', ')}`);

      client.emit('sfu:error', {
        message: 'Stream not found',
        code: 'STREAM_NOT_FOUND',
        streamId: data.streamId,
      });
      return;
    }

    // Kiểm tra xem có phải là stream presence không (không có producer thực)
    if (
      stream.producerId.startsWith('presence-') ||
      data.streamId.includes('-presence-')
    ) {
      console.log(
        `Handling presence stream without WebRTC consumer: ${data.streamId}`,
      );

      // Thay vì bỏ qua, gửi sự kiện presence trực tiếp đến client
      client.emit('sfu:presence', {
        peerId: stream.publisherId,
        metadata: stream.metadata,
      });

      return;
    }

    // Kiểm tra nếu rtpCapabilities chưa được set
    if (!participant.rtpCapabilities) {
      client.emit('sfu:error', {
        message: 'RTP capabilities not set',
        code: 'RTP_CAPABILITIES_NOT_SET',
      });
      return;
    }

    // Check if can consume
    const router = await this.sfuService.getMediaRouter(roomId);
    if (
      !router.canConsume({
        producerId: stream.producerId,
        rtpCapabilities: participant.rtpCapabilities,
      })
    ) {
      client.emit('sfu:error', {
        message: 'Cannot consume this stream',
        code: 'CANNOT_CONSUME',
      });
      return;
    }

    try {
      // Create consumer
      const consumer = await transport.consume({
        producerId: stream.producerId,
        rtpCapabilities: participant.rtpCapabilities,
        paused: true,
      });

      // Store consumer
      participant.consumers.set(consumer.id, consumer);

      // Handle when consumer is closed
      consumer.on('producerclose', () => {
        participant.consumers.delete(consumer.id);
        client.emit('sfu:consumer-closed', {
          consumerId: consumer.id,
          streamId: stream.streamId,
        });
      });

      // Emit consumer info to client
      client.emit('sfu:consumer-created', {
        consumerId: consumer.id,
        streamId: stream.streamId,
        producerId: stream.producerId,
        kind: consumer.kind,
        rtpParameters: consumer.rtpParameters,
        metadata: stream.metadata,
      });
    } catch (error) {
      console.error('Error creating consumer:', error);

      // Handle case where producer is not found
      if (error.message && error.message.includes('Producer not found')) {
        console.log(
          `Producer not found for stream: ${data.streamId}, producerId: ${stream.producerId}`,
        );

        // Remove invalid stream entry
        this.streams.delete(data.streamId);

        // Notify clients that this stream is no longer available
        const streamRoom = this.getParticipantRoom(participant);
        if (streamRoom) {
          this.io.to(streamRoom).emit('sfu:stream-removed', {
            streamId: data.streamId,
            publisherId: stream.publisherId,
            reason: 'PRODUCER_NOT_FOUND',
          });
        }
      }

      client.emit('sfu:error', {
        message: error.message || 'Error creating consumer',
        code: error.code || 'CONSUMER_ERROR',
        streamId: data.streamId,
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

    // Xử lý riêng các stream presence
    const presenceStreams = availableStreams.filter(
      (stream) =>
        stream.streamId.includes('presence') ||
        (stream.metadata && stream.metadata.type === 'presence'),
    );

    // Gửi sự kiện presence riêng cho từng stream presence
    presenceStreams.forEach((stream) => {
      setTimeout(() => {
        client.emit('sfu:presence', {
          peerId: stream.publisherId,
          metadata: stream.metadata,
        });
      }, 200);
    });
  }

  @SubscribeMessage('sfu:update')
  handleUpdateStream(
    @ConnectedSocket() client: Socket,
    @MessageBody() data: { streamId: string; metadata: any },
  ) {
    console.log(`Update stream: ${data.streamId}, metadata:`, data.metadata);

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

    if (!stream) {
      // Tìm stream theo streamId thay vì producerId
      const streamById = Array.from(this.streams.values()).find(
        (s) => s.producerId === data.streamId,
      );

      if (streamById && streamById.publisherId === participant.peerId) {
        // Cập nhật metadata nếu tìm thấy stream theo streamId
        if (data.metadata.video !== undefined) {
          streamById.metadata.video = data.metadata.video;
        }
        if (data.metadata.audio !== undefined) {
          streamById.metadata.audio = data.metadata.audio;
        }
        if (data.metadata.noCameraAvailable !== undefined) {
          streamById.metadata.noCameraAvailable =
            data.metadata.noCameraAvailable;
        }

        // Thông báo cho các client khác về sự thay đổi
        client.to(roomId).emit('sfu:stream-updated', {
          streamId: data.streamId,
          publisherId: participant.peerId,
          metadata: streamById.metadata,
        });

        console.log(
          'Stream updated by ID:',
          data.streamId,
          streamById.metadata,
        );
        return;
      }

      client.emit('sfu:error', {
        message: 'Không thể cập nhật stream không tồn tại',
        streamId: data.streamId,
      });
      return;
    }

    if (stream.publisherId !== participant.peerId) {
      client.emit('sfu:error', {
        message: 'Không thể cập nhật stream bạn không sở hữu',
        streamId: data.streamId,
      });
      return;
    }

    if (data.metadata.video !== undefined) {
      stream.metadata.video = data.metadata.video;
    }
    if (data.metadata.audio !== undefined) {
      stream.metadata.audio = data.metadata.audio;
    }
    if (data.metadata.noCameraAvailable !== undefined) {
      stream.metadata.noCameraAvailable = data.metadata.noCameraAvailable;
    }

    // Thông báo cho các client khác về sự thay đổi
    client.to(roomId).emit('sfu:stream-updated', {
      streamId: data.streamId,
      publisherId: participant.peerId,
      metadata: stream.metadata,
    });

    console.log('Stream updated:', data.streamId, stream.metadata);
  }

  @SubscribeMessage('sfu:leave-room')
  async handleLeaveRoom(
    @ConnectedSocket() client: Socket,
    @MessageBody() data: { roomId: string },
  ) {
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
    client
      .to(data.roomId)
      .emit('sfu:peer-left', { peerId: participant.peerId });

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

  @SubscribeMessage('sfu:presence')
  handlePresence(
    @ConnectedSocket() client: Socket,
    @MessageBody()
    data: {
      roomId: string;
      peerId: string;
      metadata: any;
    },
  ) {
    const participant = this.getParticipantBySocketId(client.id);
    if (!participant) {
      console.error('Participant not found for socket ID:', client.id);
      return;
    }

    const roomId = this.getParticipantRoom(participant);
    if (!roomId) {
      console.error('Room not found for participant:', participant.peerId);
      return;
    }

    // Tìm xem có stream presence nào hiện tại không
    const existingPresenceStreams = Array.from(this.streams.entries()).filter(
      ([streamId, stream]) =>
        stream.publisherId === participant.peerId &&
        (streamId.includes('presence') || stream.metadata?.type === 'presence'),
    );

    // Nếu đã có presence stream, chỉ cập nhật metadata thay vì tạo mới
    if (existingPresenceStreams.length > 0) {
      const [streamId, stream] = existingPresenceStreams[0];

      // Cập nhật metadata
      stream.metadata = {
        ...stream.metadata,
        ...data.metadata,
        type: 'presence',
        noCameraAvailable: true,
        noMicroAvailable: true,
      };

      // Chỉ gửi thông báo cập nhật nếu có thay đổi
      client.to(roomId).emit('sfu:presence', {
        peerId: participant.peerId,
        metadata: stream.metadata,
      });

      return;
    }

    // Tạo một streamId đặc biệt để đánh dấu đây là presence (không có media thực)
    const streamId = `${participant.peerId}-presence-${Date.now()}`;

    // Lưu stream "vô hình" này vào danh sách streams
    const stream: Stream = {
      streamId,
      publisherId: participant.peerId,
      producerId: 'presence-' + participant.peerId,
      metadata: {
        ...data.metadata,
        type: 'presence',
        noCameraAvailable: true,
        noMicroAvailable: true,
      },
      rtpParameters: { codecs: [], headerExtensions: [] },
    };

    this.streams.set(streamId, stream);

    // Thông báo cho tất cả người dùng khác trong phòng về sự hiện diện này
    client.to(roomId).emit('sfu:presence', {
      peerId: participant.peerId,
      metadata: {
        ...data.metadata,
        type: 'presence',
      },
    });
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

  //======================================================CHAT======================================================
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
  }

  @SubscribeMessage('sfu:lock-room')
  handleLockRoom(
    @ConnectedSocket() client: Socket,
    @MessageBody()
    data: { roomId: string; password: string },
  ) {
    const participant = this.getParticipantBySocketId(client.id);
    if (!participant) return;

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
      //Thông báo cho tất cả người dùng trong phòng phòng đã được mở khóa
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

  //======================================================WHITEBOARD======================================================
  @SubscribeMessage('whiteboard:update')
  handleWhiteboardUpdate(
    @ConnectedSocket() client: Socket,
    @MessageBody() data: { roomId: string; elements: any; state: any },
  ) {
    const { roomId, elements, state } = data;
    const participant = this.getParticipantBySocketId(client.id);

    if (!participant) return;

    // Kiểm tra xem người dùng có quyền vẽ không
    // if (!this.whiteboardService.canUserDraw(roomId, participant.peerId)) {
    //   client.emit('whiteboard:error', {
    //     message: 'Bạn không có quyền vẽ trên bảng trắng này',
    //     code: 'PERMISSION_DENIED'
    //   });
    //   return;
    // }

    // Lưu trữ dữ liệu bảng trắng
    this.whiteboardService.updateWhiteboardData(roomId, { elements, state });

    // Gửi cập nhật đến tất cả người dùng khác trong phòng
    client.to(roomId).emit('whiteboard:updated', { elements, state });
  }

  @SubscribeMessage('whiteboard:pointer-leave')
  handleWhiteboardPointerLeave(
    @ConnectedSocket() client: Socket,
    @MessageBody() data: { roomId: string },
  ) {
    const { roomId } = data;
    const participant = this.getParticipantBySocketId(client.id);

    if (!participant) return;

    // Xóa con trỏ của người dùng này
    this.whiteboardService.removeUserPointer(roomId, participant.peerId);

    // Gửi cập nhật về tất cả người dùng trong phòng
    const pointers = this.whiteboardService.getPointers(roomId);
    this.io.to(roomId).emit('whiteboard:pointers', { pointers });
  }

  @SubscribeMessage('whiteboard:pointer')
  handleWhiteboardPointer(
    @ConnectedSocket() client: Socket,
    @MessageBody() data: { roomId: string; position: PositionMouse },
  ) {
    const { roomId, position } = data;
    const participant = this.getParticipantBySocketId(client.id);

    if (!participant) return;

    // Lưu vị trí chuột với peerId
    const allPointers = this.whiteboardService.updateUserPointer(
      roomId,
      participant.peerId,
      position,
    );

    // Gửi cập nhật về tất cả người dùng trong phòng
    this.io.to(roomId).emit('whiteboard:pointers', { pointers: allPointers });
  }

  @SubscribeMessage('whiteboard:update-permissions')
  handleWhiteboardPermissions(
    @ConnectedSocket() client: Socket,
    @MessageBody() data: { roomId: string; allowed: string[] },
  ) {
    const { roomId, allowed } = data;
    const participant = this.getParticipantBySocketId(client.id);

    if (!participant) return;

    // Kiểm tra xem người dùng có phải là chủ phòng không
    if (!this.sfuService.isCreatorOfRoom(participant.peerId, roomId)) {
      client.emit('whiteboard:error', {
        message: 'Chỉ chủ phòng mới có thể cập nhật quyền vẽ bảng trắng',
        code: 'PERMISSION_DENIED',
      });
      return;
    }

    // Cập nhật quyền
    this.whiteboardService.updatePermissions(roomId, allowed);

    // Phát sóng đến tất cả người dùng trong phòng
    this.io.to(roomId).emit('whiteboard:permissions', { allowed });
  }

  @SubscribeMessage('whiteboard:get-data')
  handleGetWhiteboardData(
    @ConnectedSocket() client: Socket,
    @MessageBody() data: { roomId: string },
  ) {
    const { roomId } = data;
    const whiteboard = this.whiteboardService.getWhiteboardData(roomId);
    const permissions = this.whiteboardService.getPermissions(roomId);

    client.emit('whiteboard:data', { whiteboard });
    client.emit('whiteboard:permissions', { allowed: permissions });
  }

  @SubscribeMessage('whiteboard:clear')
  handleClearWhiteboard(
    @ConnectedSocket() client: Socket,
    @MessageBody() data: { roomId: string },
  ) {
    const { roomId } = data;
    const participant = this.getParticipantBySocketId(client.id);

    if (!participant) return;

    // Kiểm tra xem người dùng có quyền vẽ không
    if (!this.whiteboardService.canUserDraw(roomId, participant.peerId)) {
      client.emit('whiteboard:error', {
        message: 'Bạn không có quyền xóa bảng trắng này',
        code: 'PERMISSION_DENIED',
      });
      return;
    }

    // Xóa dữ liệu bảng trắng
    this.whiteboardService.clearWhiteboard(roomId);

    // Thông báo cho tất cả người dùng trong phòng
    this.io.to(roomId).emit('whiteboard:clear');
  }
}
