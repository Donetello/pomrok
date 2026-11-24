import { gameApi } from "../../game-api";

const MAX_BYTES = 4096;
const tooLarge = () => Response.json({ message: "Запит на бій завеликий." }, { status: 413 });

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
    if (!response.ok) {
      const message = response.status === 404 ? "Ця зустріч або цей герой недоступні." : "Не вдалося почати бій. Спробуй ще раз.";
      return Response.json({ message }, { status: response.status });
    }
    return Response.json(await response.json());
  } catch {
    return Response.json({ message: "Бій поки недоступний. Спробуй трохи згодом." }, { status: 502 });
  }
}
