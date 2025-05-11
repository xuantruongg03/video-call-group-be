export interface ChatMessage {
    id: string;
    roomId: string;
    sender: string;
    senderName: string;
    text: string;
    timestamp: string;
    fileUrl?: string;
    fileName?: string;
    fileType?: string;
    fileSize?: number;
    isImage?: boolean;
  }
  