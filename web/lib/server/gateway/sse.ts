// Minimal server-sent events splitter: feed decoded text, get back complete events.
// Handles events split across network chunks and \n, \r\n or \r line endings.

export type SseEvent = {
  /** Joined data lines, or null for an event with no data (a comment or keep-alive). */
  data: string | null;
  /** The event as received, without the trailing blank line. */
  raw: string;
};

export class SseSplitter {
  private buf = "";

  push(text: string): SseEvent[] {
    this.buf += text;
    // A trailing "\r" may be the first half of "\r\n": hold it until the next chunk.
    const hold = this.buf.endsWith("\r") ? 1 : 0;
    const ready = this.buf.slice(0, this.buf.length - hold).replace(/\r\n?/g, "\n");
    const parts = ready.split("\n\n");
    this.buf = parts.pop()! + this.buf.slice(this.buf.length - hold);
    return parts.filter((p) => p.length > 0).map(parseEvent);
  }

  /** Whatever is left when the stream ends without a final blank line. */
  flush(): SseEvent[] {
    const rest = this.buf.replace(/\r\n?/g, "\n").replace(/\n+$/, "");
    this.buf = "";
    return rest ? [parseEvent(rest)] : [];
  }
}

function parseEvent(raw: string): SseEvent {
  const data: string[] = [];
  for (const line of raw.split("\n")) {
    if (line === "data" || line.startsWith("data:")) data.push(line.slice(5).replace(/^ /, ""));
  }
  return { data: data.length ? data.join("\n") : null, raw };
}

export const sseData = (data: string) => `data: ${data}\n\n`;
export const sseComment = (text: string) => `: ${text}\n\n`;
