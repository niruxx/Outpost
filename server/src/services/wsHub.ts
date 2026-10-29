import type { WebSocket } from 'ws';
import { instanceEvents } from './instanceEvents.js';

type Topic = string; // `console:<serverId>`

const subscribers = new Map<Topic, Set<WebSocket>>();

export function subscribe(topic: Topic, socket: WebSocket) {
  let set = subscribers.get(topic);
  if (!set) {
    set = new Set();
    subscribers.set(topic, set);
  }
  set.add(socket);
  socket.on('close', () => unsubscribe(topic, socket));
}

export function unsubscribe(topic: Topic, socket: WebSocket) {
  subscribers.get(topic)?.delete(socket);
}

export function publish(topic: Topic, data: unknown) {
  if (topic.startsWith('console:') && data && typeof data === 'object' && ['status', 'player'].includes((data as { type: string }).type)) instanceEvents.emit('event', topic.slice(8), data);
  const set = subscribers.get(topic);
  if (!set || set.size === 0) return;
  const payload = JSON.stringify(data);
  for (const socket of set) {
    if (socket.readyState === socket.OPEN) {
      socket.send(payload);
    }
  }
}

export function consoleTopic(serverId: string): Topic {
  return `console:${serverId}`;
}
