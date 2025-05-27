# Video Call Backend - VideoMeet

<p align="center">
  <img src="https://raw.githubusercontent.com/xuantruongg03/video-call-group-be/assets/logo.png" alt="Video Call Logo" width="200"/>
</p>

A powerful, scalable NestJS-based backend for real-time video calling application using WebSockets and Selective Forwarding Unit (SFU) architecture. The system supports multi-user video conferences with advanced collaboration features.

[![License: Custom NC License](https://img.shields.io/badge/License-NC--Only-orange.svg)](LICENSE)

## ✨ Key Features

- **Multi-User Video Conferencing**: Support for multiple participants in a single room with efficient media routing
- **Selective Forwarding Unit (SFU) Architecture**: Optimized media streaming for group calls
- **Real-time Collaboration Tools**:
  - 💬 Group chat messaging with file sharing
  - 🖌️ Interactive whiteboard
  - 📊 Voting and quiz functionality
  - 📋 Screen sharing capability
- **Room Management**:
  - 🔒 Password protection
  - 👑 Room creator controls
  - 📌 Participant pinning
- **Advanced Media Handling**:
  - 🎥 Multiple video codecs support (VP8, VP9, H.264)
  - 🔊 Active speaker detection
  - 🔄 Adaptive bitrate
- **Scalable Architecture**:
  - 🚀 Worker pool for optimized performance
  - 🌐 WebRTC server for efficient media routing

## 🛠️ Technical Requirements

- Node.js (v21 or later)
- npm or yarn
- Docker (for containerized deployment)

## 🚀 Installation

### Local Development

```bash
# Clone the repository
git clone https://github.com/xuantruongg03/video-call-group-be.git
cd video-call-be

# Install dependencies
npm install

# Start development server
npm run start:dev
```

### Docker Deployment

```bash
# Build Docker image
docker build -t video-call-backend .

# Run container
docker run -p 3000:3000 -p 3002:3002 -d video-call-backend

# Allow firewall port (option on linux)
sudo ufw allow 3000/tcp
sudo ufw allow 3002/tcp
sudo ufw allow 10000:25999/udp
sudo ufw allow 55555/udp
sudo ufw allow 55555/tcp
sudo ufw allow 60555/udp
sudo ufw allow 60555/tcp
```

### Docker Compose (Recommended for Production)

Create a `docker-compose.yml` file:

```yaml
version: '3'
services:
  backend:
    build: .
    ports:
      - "3000:3000"
      - "3002:3002"
      - "10000:25999/udp"
      - "55555/udp"
      - "55555/tcp"
      - "60555/udp"
      - "60555/tcp"
    environment:
      - NODE_ENV=production
      - MEDIASOUP_LISTEN_IP=0.0.0.0
      - MEDIASOUP_ANNOUNCED_IP=your_public_ip
      - MEDIASOUP_PORT=55555
      - MEDIASOUP_RTC_MIN_PORT=10000
      - MEDIASOUP_RTC_MAX_PORT=25999
      - STUN_SERVERS=your_stun_servers
      - TURN_SERVERS=your_turn_servers
      - TURN_SERVER_USERNAME=your_username
      - TURN_SERVER_PASSWORD=your_password
      - USE_ICE_SERVERS=true
    restart: always
```

### Environment Variables

- `MEDIASOUP_LISTEN_IP`: IP address to listen on (default: 0.0.0.0)
- `MEDIASOUP_ANNOUNCED_IP`: Public IP address to announce 
- `MEDIASOUP_PORT`: Port for media streaming (default: 55555)
- `MEDIASOUP_RTC_MIN_PORT`: Minimum port for media streaming (default: 10000)
- `MEDIASOUP_RTC_MAX_PORT`: Maximum port for media streaming (default: 25999)
- `STUN_SERVERS`: STUN server(s)
- `TURN_SERVERS`: TURN server(s)
- `TURN_SERVER_USERNAME`: TURN server username
- `TURN_SERVER_PASSWORD`: TURN server password
- `USE_ICE_SERVERS`: Use ICE servers (true or false)

Then run:

```bash
docker-compose up -d
```

## 🔌 API Endpoints

- **REST API base URL**: `/api/v1`
- **WebSocket endpoint**: `:3002` (using the 'websocket' transport)

## 🌐 WebSocket Events

### Room Management
- `sfu:join` - Join a video room
- `sfu:peer-joined` - Notification when a new peer joins
- `sfu:lock-room` - Lock a room with password
- `sfu:unlock-room` - Remove password protection

### Media Streaming
- `sfu:publish` - Publish a media stream
- `sfu:subscribe` - Subscribe to a media stream
- `sfu:stream-added` - Notification when a new stream is available
- `sfu:signal` - WebRTC signaling
- `sfu:unpublish` - Stop publishing a stream
- `sfu:update-stream` - Update stream metadata

### Multi-User Features
- `sfu:remove-user` - Remove a participant from room
- `sfu:pin-user` - Pin a participant's video
- `sfu:unpin-user` - Unpin a participant's video
- `sfu:speaking` - Notify active speaker
- `sfu:stop-speaking` - Notify speaker stopped

### Collaboration Tools
- `sfu:chat-join` - Join a chat room
- `sfu:chat-message` - Send a chat message
- `sfu:chat-file` - Share file in chat
- `sfu:whiteboard-update` - Update whiteboard
- `sfu:create-vote` - Create a new vote
- `sfu:submit-vote` - Submit vote response
- `sfu:create-quiz` - Create a quiz
- `sfu:complete-quiz` - Submit quiz answers

## 📊 Multi-User Video Call Performance

This backend is specifically optimized for multi-user video conferences with:

- **Efficient Media Routing**: SFU architecture selectively forwards media streams to reduce bandwidth requirements
- **Worker Pool**: Multiple media worker processes to distribute CPU load
- **Adaptive Streaming**: Dynamic quality adjustment based on network conditions
- **Scalable Architecture**: Designed to handle multiple concurrent rooms and users
## 📄 License

This project is open source and free for non-commercial use only.  
Commercial use is **not allowed** without prior written permission.  
See [LICENSE](LICENSE) for details.
