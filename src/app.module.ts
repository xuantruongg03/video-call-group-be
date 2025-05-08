import { Module } from '@nestjs/common';
import { AppController } from './app.controller';
import { AppService } from './app.service';
import { SfuModule } from './sfu/sfu.module';
import { VideoConvertController } from './video-convert/video-convert.controller';
import { WhiteboardModule } from './whiteboard/whiteboard.module';
import { VideoConvertModule } from './video-convert/video-convert.module';

@Module({
  imports: [
    SfuModule, 
    WhiteboardModule,
    VideoConvertModule,
  ],
  controllers: [AppController, VideoConvertController],
  providers: [
    AppService,
  ],
})
export class AppModule {}
