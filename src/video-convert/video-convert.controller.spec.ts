import { Test, TestingModule } from '@nestjs/testing';
import { VideoConvertController } from './video-convert.controller';

describe('VideoConvertController', () => {
  let controller: VideoConvertController;

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      controllers: [VideoConvertController],
    }).compile();

    controller = module.get<VideoConvertController>(VideoConvertController);
  });

  it('should be defined', () => {
    expect(controller).toBeDefined();
  });
});
