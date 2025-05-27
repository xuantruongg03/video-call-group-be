import { Module, forwardRef } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { WhiteboardModule } from '../whiteboard/whiteboard.module';
import { SfuController } from './sfu.controller';
import { SfuGateway } from './sfu.gateway';
import { SfuService } from './sfu.service';
import { BehaviorService } from './behavior.service';
import { BehaviorController } from './behavior.controller';
import { WorkerPoolService } from 'src/worker-pool/worker-pool.service';
import { EventEmitter2 } from 'eventemitter2';

@Module({
  providers: [SfuGateway, SfuService, ConfigService, BehaviorService, WorkerPoolService, EventEmitter2],
  controllers: [SfuController, BehaviorController],
  exports: [SfuService, BehaviorService],
  imports: [forwardRef(() => WhiteboardModule)]
})
export class SfuModule {} 