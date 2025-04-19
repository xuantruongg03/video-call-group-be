import { Module } from '@nestjs/common';
import { AppController } from './app.controller';
import { AppService } from './app.service';
import { SfuModule } from './sfu/sfu.module';
import { RouterModule, Routes } from '@nestjs/core';

const routes: Routes = [
  {
    path: 'sfu',
    module: SfuModule,
  },
];

@Module({
  imports: [SfuModule],
  controllers: [AppController],
  providers: [AppService],
})
export class AppModule {}
