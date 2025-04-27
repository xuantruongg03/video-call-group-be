import { Module } from '@nestjs/common';
import { SfuGateway } from './sfu.gateway';
import { SfuController } from './sfu.controller';
import { SfuService } from './sfu.service';
import { ConfigService } from '@nestjs/config';

@Module({
  providers: [SfuGateway, SfuService, ConfigService],
  controllers: [SfuController],
  exports: [SfuGateway]
})
export class SfuModule {} 