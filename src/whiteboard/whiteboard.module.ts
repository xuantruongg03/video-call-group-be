import { Module, forwardRef } from '@nestjs/common';
import { WhiteboardService } from './whiteboard.service';
import { SfuModule } from '../sfu/sfu.module';

@Module({
  imports: [forwardRef(() => SfuModule)],
  providers: [WhiteboardService],
  exports: [WhiteboardService],
})
export class WhiteboardModule {}