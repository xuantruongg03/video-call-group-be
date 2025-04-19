import { Module } from '@nestjs/common';
import { SfuGateway } from './sfu.gateway';
import { SfuController } from './sfu.controller';
import { SfuService } from './sfu.service';

@Module({
  providers: [SfuGateway, SfuService],
  controllers: [SfuController],
  exports: [SfuGateway]
})
export class SfuModule {} 