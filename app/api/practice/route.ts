import { gameApi } from "../../game-api";

const MAX_BYTES = 4096;
const tooLarge = () => Response.json({ message: "Fight request is too large." }, { status: 413 });

export async function POST(request: Request) {
  if (Number(request.headers.get("content-length")) > MAX_BYTES) return tooLarge();

  try {
    const reader = request.body?.getReader();
    const decoder = new TextDecoder();
    let bytes = 0;
    let body = "";
    if (reader) {
      for (let chunk = await reader.read(); !chunk.done; chunk = await reader.read()) {
        bytes += chunk.value.byteLength;
        if (bytes > MAX_BYTES) {
          await reader.cancel();
          return tooLarge();
        }
        body += decoder.decode(chunk.value, { stream: true });
      }
      body += decoder.decode();
    }
    const response = await gameApi("/practice", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body,
    });
    return Response.json(await response.json(), { status: response.status });
  } catch {
    return Response.json({ message: "The arena is unavailable. Try again in a moment." }, { status: 502 });
  }
}
