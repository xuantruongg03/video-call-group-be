import { Injectable } from '@nestjs/common';
import { UserBehaviorLog, UserEvent } from '../interfaces/behavior';
import * as ExcelJS from 'exceljs';

@Injectable()
export class BehaviorService {
  private userLogs = new Map<string, Map<string, UserBehaviorLog>>();

  private initRoomLogs(roomId: string): void {
    if (!this.userLogs.has(roomId)) {
      this.userLogs.set(roomId, new Map<string, UserBehaviorLog>());
    }
  }

  saveUserBehavior(userId: string, roomId: string, events: UserEvent[]): void {
    this.initRoomLogs(roomId);
    const roomLogs = this.userLogs.get(roomId);
    
    if (roomLogs && roomLogs.has(userId)) {
      const existingLog = roomLogs.get(userId);
      if (existingLog) {
        existingLog.events = [...existingLog.events, ...events];
        existingLog.lastUpdated = new Date();
        roomLogs.set(userId, existingLog);
      }
    } else if (roomLogs) {
      const newLog: UserBehaviorLog = {
        userId,
        roomId,
        events,
        lastUpdated: new Date()
      };
      roomLogs.set(userId, newLog);
    }
  }

  getUserBehavior(roomId: string, userId: string): UserBehaviorLog | null {
    const roomLogs = this.userLogs.get(roomId);
    if (!roomLogs) {
      return null;
    }
    return roomLogs.get(userId) || null;
  }

  getRoomLogs(roomId: string): UserBehaviorLog[] {
    const roomLogs = this.userLogs.get(roomId);
    if (!roomLogs) {
      return [];
    }
    return Array.from(roomLogs.values());
  }

  clearUserLogs(roomId: string, userId: string): void {
    const roomLogs = this.userLogs.get(roomId);
    if (roomLogs) {
      roomLogs.delete(userId);
    }
  }

  clearRoomLogs(roomId: string): void {
    this.userLogs.delete(roomId);
  }

  async generateRoomLogExcel(roomId: string): Promise<Buffer> {
    const roomLogs = this.getRoomLogs(roomId);
    if (!roomLogs) {
      throw new Error('Room logs not found');
    }

    const workbook = new ExcelJS.Workbook();
    const worksheet = workbook.addWorksheet('Behavior Log');

    worksheet.addRow(['User ID', 'Event Type', 'Value', 'Timestamp']);
   
    roomLogs.forEach(log => {
      log.events.forEach(event => {
        worksheet.addRow([log.userId, event.type, event.value.toString(), new Date(event.time).toLocaleString()]);
      });
    });
    
    const headerRow = worksheet.getRow(1);
    headerRow.font = { bold: true };
    headerRow.eachCell((cell) => {
      cell.fill = {
        type: 'pattern',
        pattern: 'solid',
        fgColor: { argb: 'FFE0E0E0' }
      };
      cell.border = {
        top: { style: 'thin' },
        left: { style: 'thin' },
        bottom: { style: 'thin' },
        right: { style: 'thin' }
      };
    });

    worksheet.columns.forEach(column => {
      column.width = 25;
    });

    return await workbook.xlsx.writeBuffer() as Buffer;
  }

  async generateUserLogExcel(roomId: string, userId: string): Promise<Buffer> {
    const userLog = this.getUserBehavior(roomId, userId);
    if (!userLog) {
      throw new Error('User logs not found');
    }

    const workbook = new ExcelJS.Workbook();
    const worksheet = workbook.addWorksheet('Behavior Log');

    worksheet.addRow(['Event Type', 'Value', 'Timestamp']);

    userLog.events.forEach(event => {
      worksheet.addRow([
        event.type,
        event.value.toString(),
        new Date(event.time).toLocaleString()
      ]);
    });
    const headerRow = worksheet.getRow(1);
    headerRow.font = { bold: true };
    headerRow.eachCell((cell) => {
      cell.fill = {
        type: 'pattern',
        pattern: 'solid',
        fgColor: { argb: 'FFE0E0E0' }
      };
      cell.border = {
        top: { style: 'thin' },
        left: { style: 'thin' },
        bottom: { style: 'thin' },
        right: { style: 'thin' }
      };
    });

    worksheet.columns.forEach(column => {
      column.width = 25;
    });

    return await workbook.xlsx.writeBuffer() as Buffer;
  }
} 