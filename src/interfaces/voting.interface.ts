export interface VoteOption {
  id: string;
  text: string;
  votes: number;
}

export interface VoteSession {
  id: string;
  creatorId: string;
  question: string;
  options: VoteOption[];
  participants: string[];
  isActive: boolean;
  createdAt: Date;
}

export interface VoteData {
  roomId: string;
  voteId: string;
  optionId: string;
  voterId: string;
} 