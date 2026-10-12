import { EventRoom, type Env } from "./room";

export { EventRoom };

// One event, one room. The name is fixed so every request reaches the same
// Durable Object.
const ROOM_NAME = "friendsmas";

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    if (url.pathname.startsWith("/api/")) {
      const stub = env.ROOM.get(env.ROOM.idFromName(ROOM_NAME));
      return stub.fetch(request);
    }
    return env.ASSETS.fetch(request);
  },
} satisfies ExportedHandler<Env>;
