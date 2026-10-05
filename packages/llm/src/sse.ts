/**
 * Server-sent events, read off a response body.
 *
 * Both wire formats stream their answers this way. The parser is the one the standard describes and nothing more: fields
 * are `name: value` lines, an empty line ends an event, a line starting with `:` is a comment, several `data` lines
 * join with a newline, and lines may end in `\n`, `\r\n` or `\r`. Bytes are decoded as a stream, so a character split
 * across two chunks is not corrupted.
 */

export interface SseMessage {
  /** The `event` field; `message` when the server named none. */
  event: string;
  data: string;
}

export async function* parseSse(chunks: AsyncIterable<Uint8Array>): AsyncGenerator<SseMessage, void> {
  const decoder = new TextDecoder("utf-8");
  let buffer = "";
  let event = "";
  let data: string[] = [];

  const flush = (): SseMessage | undefined => {
    if (data.length === 0) {
      event = "";
      return undefined;
    }
    const message = { event: event || "message", data: data.join("\n") };
    event = "";
    data = [];
    return message;
  };

  const line = (text: string): SseMessage | undefined => {
    if (text === "") return flush();
    if (text.startsWith(":")) return undefined;
    const colon = text.indexOf(":");
    const field = colon === -1 ? text : text.slice(0, colon);
    let value = colon === -1 ? "" : text.slice(colon + 1);
    if (value.startsWith(" ")) value = value.slice(1);
    if (field === "event") event = value;
    else if (field === "data") data.push(value);
    return undefined;
  };

  for await (const chunk of chunks) {
    buffer += decoder.decode(chunk, { stream: true });
    // A `\r` at the very end of the buffer may be the first half of `\r\n`: wait for the next chunk to know.
    let start = 0;
    for (let i = 0; i < buffer.length; i++) {
      const c = buffer[i];
      if (c !== "\n" && c !== "\r") continue;
      if (c === "\r" && i === buffer.length - 1) break;
      const message = line(buffer.slice(start, i));
      if (c === "\r" && buffer[i + 1] === "\n") i++;
      start = i + 1;
      if (message) yield message;
    }
    buffer = buffer.slice(start);
  }
  buffer += decoder.decode();
  if (buffer !== "") {
    const message = line(buffer);
    if (message) yield message;
  }
  const last = flush();
  if (last) yield last;
}
