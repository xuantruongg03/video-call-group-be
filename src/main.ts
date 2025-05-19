// src/main.ts
import { NestFactory } from '@nestjs/core';
import { AppModule } from './app.module';
import * as fs from 'fs';
import { IoAdapter } from '@nestjs/platform-socket.io';
import { ConfigModule } from '@nestjs/config';

// Tạo adapter SSL cho WebSocket
// class SecureIoAdapter extends IoAdapter {
//   createIOServer(port: number, options?: any): any {
//     const httpsOptions = {
//       key: fs.readFileSync('./secrets/private-key.pem'),
//       cert: fs.readFileSync('./secrets/public-certificate.pem'),
//     };
    
//     options.path = '/socket.io';
    
//     const server = require('https').createServer(httpsOptions);
//     const io = require('socket.io')(server, options);
    
//     server.listen(port);
//     return io;
//   }
// }

async function bootstrap() {
  // Load environment variables
  await ConfigModule.forRoot({
    isGlobal: true, // Make the module global
  });

  // const httpsOptions = {
  //   key: fs.readFileSync('./secrets/private-key.pem'),
  //   cert: fs.readFileSync('./secrets/public-certificate.pem'),
  // };
  
  const app = await NestFactory.create(AppModule);

  // const app = await NestFactory.create(AppModule, {
  //   httpsOptions,
  // });
  
  // Sử dụng adapter an toàn cho WebSocket
  // app.useWebSocketAdapter(new SecureIoAdapter(app));
  
  app.enableCors({
    origin: '*',
    methods: 'GET,HEAD,PUT,PATCH,POST,DELETE',
    allowedHeaders: 'Content-Type,Accept,Authorization',
    credentials: true,
  });
  
  app.setGlobalPrefix('api/v1');
  
  await app.listen(3000);
}

bootstrap();
