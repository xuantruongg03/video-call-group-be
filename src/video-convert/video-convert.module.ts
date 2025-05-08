import { Module, forwardRef } from '@nestjs/common';
import { WhiteboardModule } from '../whiteboard/whiteboard.module';
import { VideoConvertController } from './video-convert.controller';
import { VideoConverterService } from './video-converter.service';

@Module({
  providers: [VideoConverterService],
  controllers: [VideoConvertController],
  exports: [VideoConverterService],
  imports: [forwardRef(() => WhiteboardModule)]
})
export class VideoConvertModule {} 