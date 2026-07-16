import { WebSocket } from 'ws';

type WsClient = WebSocket & { isAlive?: boolean };

const clients = new Set<WsClient>();

export function registerClient(ws: WsClient): void {
  ws.isAlive = true;
  clients.add(ws);
  ws.on('pong', () => { ws.isAlive = true; });
  ws.on('close', () => clients.delete(ws));
}

export function broadcast(data: unknown): void {
  const payload = JSON.stringify(data);
  for (const client of clients) {
    if (client.readyState === WebSocket.OPEN) {
      client.send(payload);
    }
  }
}

export function startHeartbeat(): void {
  setInterval(() => {
    for (const client of clients) {
      if (!client.isAlive) {
        client.terminate();
        clients.delete(client);
        continue;
      }
      client.isAlive = false;
      client.ping();
    }
  }, 30000);
}
