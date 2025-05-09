export interface QuizOption {
  id: string;
  text: string;
  isCorrect: boolean;
}

export interface QuizQuestion {
  id: string;
  text: string;
  type: 'multiple-choice' | 'essay' | 'one-choice';
  options?: QuizOption[];
  correctAnswers?: string[]; 
  answer?: string; 
}

export interface QuizSession {
  id: string;
  creatorId: string;
  title: string;
  questions: QuizQuestion[];
  participants: {
    participantId: string;
    answers: {
      questionId: string;
      selectedOptions?: string[];
      essayAnswer?: string; 
    }[];
    score?: number;
    completed: boolean;
    startedAt?: Date;
    finishedAt?: Date;
  }[];
  isActive: boolean;
  createdAt: Date;
}

export interface QuizParticipantResponse {
  participantId: string;
  quizId: string;
  questions: {
      questionId: string;
      type: 'multiple-choice' | 'essay' | 'one-choice';
      selectedOptions?: string[];
      essayAnswer?: string;
  }[];
} 