# Video Call Backend

A NestJS-based backend for a real-time video calling application using WebSockets and Selective Forwarding Unit (SFU) architecture.

## Features

- Real-time video/audio streaming with WebRTC
- Selective Forwarding Unit (SFU) for efficient media routing
- Room-based video conferences
- Real-time chat messaging in rooms
- Room password protection
- Cross-Origin Resource Sharing (CORS) enabled

## Prerequisites

- Node.js (v14 or later)
- npm or yarn

## Installation

```bash
# Clone the repository
git clone https://github.com/xuantruongg03/video-call-group-be.git
cd video-call-be

# Install dependencies
npm install
```

## Running the application

```bash
# Development mode
npm run start:dev

# Production mode
npm run build
npm run start:prod
```

The application runs on port 3000 for HTTP endpoints and port 3002 for WebSocket connections.

## Exposing to the internet (for development)

You can use ngrok to expose your local server to the internet:

```bash
ngrok start --config="C:\Users\lexua\Downloads\ngrok-v3-stable-windows-amd64\ngrok.yml" --all
```

## API Endpoints

- REST API base URL: `/api/v1`
- WebSocket endpoint: `:3002` (using the 'websocket' transport)

## WebSocket Events

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

### Chat
- `sfu:chat-join` - Join a chat room
- `sfu:chat-message` - Send a chat message
- `sfu:chat-leave` - Leave a chat room

## License

[UNLICENSED]