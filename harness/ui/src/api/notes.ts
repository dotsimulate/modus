import { API_BASE, authHeaders } from "./_fetch";

export type NoteListItem = {
  id: string;
  title: string;
  created: string | null;
  updated: string | null;
  tags: string[];
  preview: string;
};

export type NoteDetail = {
  id: string;
  title: string;
  created: string | null;
  updated: string | null;
  tags: string[];
  content: string;
};

export async function fetchNotes(cwd: string): Promise<NoteListItem[]> {
  const res = await fetch(
    `${API_BASE}/api/notes?cwd=${encodeURIComponent(cwd)}`,
    { headers: authHeaders() },
  );
  if (!res.ok) return [];
  return res.json();
}

export async function fetchNote(id: string, cwd: string): Promise<NoteDetail | null> {
  const res = await fetch(
    `${API_BASE}/api/notes/${encodeURIComponent(id)}?cwd=${encodeURIComponent(cwd)}`,
    { headers: authHeaders() },
  );
  if (!res.ok) return null;
  return res.json();
}

export async function createNote(
  cwd: string,
  data: { title?: string; content?: string; tags?: string[] },
): Promise<{ id: string; title: string; created: string; updated: string }> {
  const res = await fetch(
    `${API_BASE}/api/notes?cwd=${encodeURIComponent(cwd)}`,
    {
      method: "POST",
      headers: { ...authHeaders(), "Content-Type": "application/json" },
      body: JSON.stringify(data),
    },
  );
  return res.json();
}

export async function updateNote(
  id: string,
  cwd: string,
  data: { title?: string; content?: string; tags?: string[] },
): Promise<{ id: string; title: string; updated: string }> {
  const res = await fetch(
    `${API_BASE}/api/notes/${encodeURIComponent(id)}?cwd=${encodeURIComponent(cwd)}`,
    {
      method: "PUT",
      headers: { ...authHeaders(), "Content-Type": "application/json" },
      body: JSON.stringify(data),
    },
  );
  return res.json();
}

export async function deleteNote(id: string, cwd: string): Promise<void> {
  await fetch(
    `${API_BASE}/api/notes/${encodeURIComponent(id)}?cwd=${encodeURIComponent(cwd)}`,
    { method: "DELETE", headers: authHeaders() },
  );
}

export async function transcribeAudio(file: File): Promise<string> {
  const form = new FormData();
  form.append("file", file, file.name);
  const res = await fetch(`${API_BASE}/api/whisper/transcribe`, {
    method: "POST",
    headers: authHeaders(),
    body: form,
  });
  if (!res.ok) throw new Error("Transcription failed");
  const data = await res.json();
  return data.text || "";
}
