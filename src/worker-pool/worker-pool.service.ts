import { Injectable, OnModuleInit } from '@nestjs/common';
import * as mediasoup from 'mediasoup';
import * as os from 'os';
import { EventEmitter2 } from 'eventemitter2';
import { ConfigService } from '@nestjs/config';

@Injectable()
export class WorkerPoolService implements OnModuleInit {
  private workers: { worker: mediasoup.types.Worker; webRtcServer: mediasoup.types.WebRtcServer }[] = [];
  private nextWorkerIndex = 0;
  private readonly numWorkers: number;
  private workerLoads = new Map<
    string,
    { rooms: number; consumers: number; producers: number }
  >();
  private webRtcServers = new Map<string, mediasoup.types.WebRtcServer | undefined>();
  private sharedWebRtcServer: mediasoup.types.WebRtcServer;

  constructor(private readonly eventEmitter: EventEmitter2, private readonly configService: ConfigService) {
    // Lấy số lượng CPU core, tối đa 16
    const numCores = os.cpus().length;
    this.numWorkers = Math.min(numCores, 16);
    // this.numWorkers = 1;
    console.log(`Creating ${this.numWorkers} mediasoup Workers...`);
  }

  async onModuleInit() {
    await this.createWorkers();
  }

  setSharedWebRtcServer(webRtcServer: mediasoup.types.WebRtcServer) {
    this.sharedWebRtcServer = webRtcServer;
    console.log(`Shared WebRTC server set with ID: ${webRtcServer.id}`);
  }

  getSharedWebRtcServer(workerId: string | undefined): mediasoup.types.WebRtcServer | undefined {
    if (!workerId) {
      return this.sharedWebRtcServer;
    }
    return this.webRtcServers.get(workerId);
  }

  private async createWorkers() {
    // const baseMinPort = parseInt(this.configService.get('MEDIASOUP_RTC_MIN_PORT') || '10000', 10);
    const baseMinPort = 10000;
    const portRangePerWorker = 1000;
    for (let i = 0; i < this.numWorkers; i++) {
      const worker = await mediasoup.createWorker({
        logLevel: 'warn',
        logTags: ['info', 'ice', 'dtls', 'rtp', 'srtp', 'rtcp'],
        rtcMinPort: baseMinPort + i * portRangePerWorker,
        rtcMaxPort: baseMinPort + (i + 1) * portRangePerWorker - 1,
      });
      
      // Create a WebRTC server for each worker
      const webRtcServer = await worker.createWebRtcServer({
        listenInfos: [
          {
            protocol: 'udp',
            ip: this.configService.get('MEDIASOUP_LISTEN_IP') || '0.0.0.0',
            announcedIp: this.configService.get('MEDIASOUP_ANNOUNCED_IP'),
            port: parseInt(this.configService.get('MEDIASOUP_PORT') || '55555') + i // Use different ports for each worker
          },
          {
            protocol: 'tcp',
            ip: this.configService.get('MEDIASOUP_LISTEN_IP') || '0.0.0.0',
            announcedIp: this.configService.get('MEDIASOUP_ANNOUNCED_IP'),
            port: parseInt(this.configService.get('MEDIASOUP_PORT') || '55555') + i
          }
        ]
      });
      
      // Store the worker and its WebRTC server
      this.workers.push({ worker, webRtcServer });
      this.webRtcServers.set(worker.pid.toString(), webRtcServer);
      console.log(`Created worker ${i} with ID ${worker.pid}`);

      worker.on('died', () => this.handleWorkerDied(worker, i));

      this.workerLoads.set(worker.pid.toString(), {
        rooms: 0,
        consumers: 0,
        producers: 0,
      });

      // setInterval(async () => {
      //   const usage = await worker.getResourceUsage();
      //   console.log(
      //     `mediasoup Worker ${i} resource usage: ${JSON.stringify(usage)}`,
      //   );
      // }, 120000);
    }

    console.log(`${this.workers.length} mediasoup Workers created`);
  }

  getWorker(): mediasoup.types.Worker {
    const worker = this.workers[this.nextWorkerIndex].worker;

    this.nextWorkerIndex = (this.nextWorkerIndex + 1) % this.workers.length;

    return worker;
  }

  async getLeastLoadedWorker(): Promise<mediasoup.types.Worker> {
    if (this.workers.length === 1) {
      return this.workers[0].worker;
    }

    let leastLoadedWorker = this.workers[0].worker;
    let lowestLoad = Infinity;

    for (const { worker } of this.workers) {
      const usage = await worker.getResourceUsage();
      const cpuTime = usage.ru_utime + usage.ru_stime;
      const memory = usage.ru_maxrss;

      const load = cpuTime * 1000 + memory;

      if (load < lowestLoad) {
        lowestLoad = load;
        leastLoadedWorker = worker;
      }
    }

    return leastLoadedWorker;
  }

  getWorkerByRoomId(roomId: string): mediasoup.types.Worker {
    const sum = roomId
      .split('')
      .reduce((acc, char) => acc + char.charCodeAt(0), 0);
    const workerIndex = sum % this.workers.length;

    return this.workers[workerIndex].worker;
  }

  getAllWorkers(): mediasoup.types.Worker[] {
    return this.workers.map(entry => entry.worker);
  }

  async closeAll() {
    for (const { worker } of this.workers) {
      await worker.close();
    }
  }

  updateWorkerLoad(
    workerId: string,
    data: { rooms?: number; consumers?: number; producers?: number },
  ) {
    const currentLoad = this.workerLoads.get(workerId) || {
      rooms: 0,
      consumers: 0,
      producers: 0,
    };

    this.workerLoads.set(workerId, {
      rooms: data.rooms !== undefined ? data.rooms : currentLoad.rooms,
      consumers:
        data.consumers !== undefined ? data.consumers : currentLoad.consumers,
      producers:
        data.producers !== undefined ? data.producers : currentLoad.producers,
    });
  }

  getOptimalWorker(): mediasoup.types.Worker {
    if (this.workers.length === 1) {
      return this.workers[0].worker;
    }

    let optimalWorker = this.workers[0].worker;
    let lowestLoad = Infinity;

    for (const { worker } of this.workers) {
      const workerId = worker.pid.toString();
      const load = this.workerLoads.get(workerId);

      const totalLoad = load
        ? load.rooms * 10 + load.consumers * 2 + load.producers * 5
        : 0;

      if (totalLoad < lowestLoad) {
        lowestLoad = totalLoad;
        optimalWorker = worker;
      }
    }

    return optimalWorker;
  }

  private async handleWorkerDied(
    worker: mediasoup.types.Worker,
    index: number,
  ) {
    console.error(`mediasoup Worker ${index} died, creating a new one...`);

    const deadWorkerId = worker.pid.toString();
    this.workers.splice(index, 1);
    this.workerLoads.delete(deadWorkerId);

    const newWorker = await mediasoup.createWorker({
      logLevel: 'warn',
      logTags: ['info', 'ice', 'dtls', 'rtp', 'srtp', 'rtcp'],
      rtcMinPort: 10000 + index * 1000,
      rtcMaxPort: 10999 + index * 1000,
    });

    const webRtcServer = await newWorker.createWebRtcServer({
      listenInfos: [
        {
          protocol: 'udp',
          ip: this.configService.get('MEDIASOUP_LISTEN_IP') || '0.0.0.0',
          announcedIp: this.configService.get('MEDIASOUP_ANNOUNCED_IP'),
          port: parseInt(this.configService.get('MEDIASOUP_PORT') || '55555') + index
        },
        {
          protocol: 'tcp',
          ip: this.configService.get('MEDIASOUP_LISTEN_IP') || '0.0.0.0',
          announcedIp: this.configService.get('MEDIASOUP_ANNOUNCED_IP'),
          port: parseInt(this.configService.get('MEDIASOUP_PORT') || '55555') + index
        }
      ]
    });

    newWorker.on('died', () => this.handleWorkerDied(newWorker, index));

    this.workers.splice(index, 0, { worker: newWorker, webRtcServer });

    console.log(`New mediasoup Worker created with pid ${newWorker.pid}`);
    this.eventEmitter.emit('worker.replaced', {
      oldWorkerId: deadWorkerId,
      newWorkerId: newWorker.pid.toString(),
    });
  }

  getWebRtcServer(workerId: string): mediasoup.types.WebRtcServer | undefined {
    if (this.sharedWebRtcServer) {
      return this.sharedWebRtcServer;
    }
    
    return this.webRtcServers.get(workerId);
  }

  getWebRtcServerForWorker(workerId: string) {
    const workerEntry = this.workers.find(entry => entry.worker.pid.toString() === workerId);
    return workerEntry?.webRtcServer;
  }
}
