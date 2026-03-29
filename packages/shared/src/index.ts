export type NotebookDto = {
  id: string;
  name: string;
  sortOrder: number;
  createdAt: string;
  updatedAt: string;
};

export type NoteDto = {
  id: string;
  notebookId: string;
  title: string;
  body: string;
  createdAt: string;
  updatedAt: string;
  evernoteGuid: string | null;
};

export type AttachmentDto = {
  id: string;
  noteId: string;
  filename: string;
  mimeType: string;
  sizeBytes: number;
  downloadUrl?: string;
};

export type ImportJobDto = {
  id: string;
  status: "pending" | "processing" | "completed" | "failed";
  notebookId: string | null;
  fileName: string | null;
  notesCreated: number;
  notesSkipped: number;
  error: string | null;
  createdAt: string;
  updatedAt: string;
};

export type SearchHitDto = {
  note: NoteDto;
  rank: number;
  headline: string | null;
};
