import { Module } from '@nestjs/common';
import { AppController } from './app.controller';
import { AppService } from './app.service';
import { SfuModule } from './sfu/sfu.module';
import { WhiteboardModule } from './whiteboard/whiteboard.module';

@Module({
  imports: [SfuModule, WhiteboardModule],
  controllers: [AppController],
  providers: [AppService],
})
export class AppModule {}
