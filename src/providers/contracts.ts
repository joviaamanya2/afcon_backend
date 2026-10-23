export interface FootballDataProvider {
  readonly name: string;
  getMatches(input: { date?: string; competitionId?: string }): Promise<unknown[]>;
  getTeams(input: { competitionId?: string }): Promise<unknown[]>;
  getStandings(input: { competitionId: string; group?: string }): Promise<unknown[]>;
}

export interface VerifiedAnswerContext {
  question: string;
  language: string;
  facts: Array<{ text: string; source: string; updatedAt: string }>;
}

export interface TournamentAssistantProvider {
  answer(input: VerifiedAnswerContext): Promise<{ answer: string; citations: string[] }>;
}

export interface SpeechTranslationProvider {
  /** Transcribe one English audio segment; implementations may use streaming STT. */
  transcribe(input: { audio: AsyncIterable<Uint8Array>; format: string; language: 'en' }): Promise<string>;
  translate(input: { text: string; source: 'en'; target: 'lg' }): Promise<string>;
  /** Yield playable audio segments encoded using the negotiated output format. */
  speak(input: { text: string; language: 'lg'; format: string }): AsyncIterable<Uint8Array>;
}
