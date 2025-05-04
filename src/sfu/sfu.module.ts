import { Module, forwardRef } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { WhiteboardModule } from '../whiteboard/whiteboard.module';
import { SfuController } from './sfu.controller';
import { SfuGateway } from './sfu.gateway';
import { SfuService } from './sfu.service';

@Module({
  providers: [SfuGateway, SfuService, ConfigService],
  controllers: [SfuController],
  exports: [SfuService],
  imports: [forwardRef(() => WhiteboardModule)]
})
export class SfuModule {} 