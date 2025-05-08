import { Injectable } from '@nestjs/common';
import * as ffmpeg from 'fluent-ffmpeg';
import * as ffmpegInstaller from '@ffmpeg-installer/ffmpeg';
import { join } from 'path';
import { writeFile, readFile, unlink } from 'fs/promises';
import { randomUUID } from 'crypto';
import { existsSync, mkdirSync } from 'fs';

@Injectable()
export class VideoConverterService {
  constructor() {
    ffmpeg.setFfmpegPath(ffmpegInstaller.path);
    
    const tempDir = join(process.cwd(), 'temp');
    if (!existsSync(tempDir)) {
      mkdirSync(tempDir);
    }
  }

  async convertWebmToMp4(webmBuffer: Buffer): Promise<Buffer> {
    const tempDir = join(process.cwd(), 'temp');
    const inputPath = join(tempDir, `${randomUUID()}.webm`);
    const outputPath = join(tempDir, `${randomUUID()}.mp4`);

    try {
      // Write input file
      await writeFile(inputPath, webmBuffer);

      // Convert to MP4
      await new Promise<void>((resolve, reject) => {
        ffmpeg(inputPath)
          .outputOptions([
            '-c:v libx264',     // Video codec
            '-preset fast',      // Encoding speed preset
            '-crf 23',          // Quality (lower = better, 18-28 is good)
            '-c:a aac',         // Audio codec
            '-b:a 128k',        // Audio bitrate
            '-movflags +faststart' // Enable streaming
          ])
          .on('progress', (progress) => {
            if (progress.percent) {
              // Emit progress through socket if needed
              console.log('Processing: ' + Math.round(progress.percent) + '% done');
            }
          })
          .on('end', () => resolve())
          .on('error', (err) => reject(err))
          .save(outputPath);
      });

      // Read output file
      const outputBuffer = await readFile(outputPath);

      // Clean up
      await Promise.all([
        unlink(inputPath),
        unlink(outputPath)
      ]).catch(console.error);

      return outputBuffer;
    } catch (error) {
      // Clean up on error
      await Promise.all([
        unlink(inputPath).catch(() => {}),
        unlink(outputPath).catch(() => {})
      ]);
      throw error;
    }
  }
} 