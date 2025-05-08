import { Controller, Post, UseInterceptors, UploadedFile } from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import { VideoConverterService } from './video-converter.service';

@Controller('convert-video')
export class VideoConvertController {
  constructor(private readonly videoConverterService: VideoConverterService) {}

  @Post('convert')
  @UseInterceptors(FileInterceptor('file', {
    limits: {
      fileSize: 1024 * 1024 * 1024, // 1GB
    },
  }))
  async convertVideo(@UploadedFile() file: Express.Multer.File) {
    if(file.size === 0) {
      throw new Error('Video không hợp lệ');
    }
    try {
      const mp4Buffer = await this.videoConverterService.convertWebmToMp4(file.buffer);
      console.log(`Convert video ${file.originalname} to mp4 success`);
      return {
        data: mp4Buffer,
        headers: {
          'Content-Type': 'video/mp4',
          'Content-Disposition': `attachment; filename="recording-${Date.now()}.mp4"`
        }
      };
    } catch (error) {
      console.error('Error converting video:', error);
      throw new Error('Video conversion failed');
    }
  }
} 