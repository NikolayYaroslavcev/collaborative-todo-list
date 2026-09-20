import { io, Socket } from "socket.io-client";

const WS_URL = process.env.NEXT_PUBLIC_WS_URL ?? "http://localhost:3001";

export function createSocket(token: string): Socket {
  return io(WS_URL, {
    auth: { token },
    autoConnect: false,
    reconnection: true,
    reconnectionDelay: 500,
    reconnectionDelayMax: 5000,
  });
}
