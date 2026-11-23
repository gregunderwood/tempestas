import type { RealtimeEvent, RealtimePayloads } from '@tempestas/domain';

export interface PushedEvent {
  event: RealtimeEvent;
  payload: RealtimePayloads[RealtimeEvent];
}

const SOCKET_IO_PATH = '/socket.io/';
const SOCKET_SESSION_ID = 'smoke-test';
const WEBSOCKET_OPEN = 1;
const WEBSOCKET_CLOSED = 3;
const NORMAL_CLOSURE = 1000;
const HEARTBEAT_NEVER_DUE_MILLISECONDS = 3_600_000;

// Engine.IO v4 packet types, then Socket.IO v5 packet types inside its message packet.
const ENGINE_OPEN = '0';
const ENGINE_PING = '2';
const ENGINE_PONG = '3';
const ENGINE_MESSAGE = '4';
const SOCKET_CONNECT = '0';
const SOCKET_EVENT = '2';
const NAMESPACE_CONNECT_REQUEST = ENGINE_MESSAGE + SOCKET_CONNECT;

type MessageListener = (message: { data: string }) => void;

// Socket.IO tries the websocket transport first, so faking WebSocket answers it before any proxy is asked.
export function installFakeRealtimeServer(
  window: Cypress.AUTWindow,
  eventsOnConnect: readonly PushedEvent[],
): void {
  const RealWebSocket = window.WebSocket;

  class FakeSocketIoWebSocket {
    static readonly CONNECTING = 0;
    static readonly OPEN = WEBSOCKET_OPEN;
    static readonly CLOSING = 2;
    static readonly CLOSED = WEBSOCKET_CLOSED;

    readyState = WEBSOCKET_OPEN;
    binaryType = 'blob';
    onopen: (() => void) | null = null;
    onclose: ((event: { code: number }) => void) | null = null;
    onerror: (() => void) | null = null;
    onmessage: MessageListener | null = null;

    constructor(url: string | URL, protocols?: string | string[]) {
      if (!String(url).includes(SOCKET_IO_PATH)) {
        return new RealWebSocket(
          url,
          protocols,
        ) as unknown as FakeSocketIoWebSocket;
      }
      window.setTimeout(() => this.openEngineSession());
    }

    send(frame: string): void {
      if (frame === ENGINE_PING) this.deliver(ENGINE_PONG);
      if (frame === NAMESPACE_CONNECT_REQUEST) this.acceptNamespace();
    }

    close(): void {
      this.readyState = WEBSOCKET_CLOSED;
      this.onclose?.({ code: NORMAL_CLOSURE });
    }

    private openEngineSession(): void {
      this.onopen?.();
      this.deliver(
        ENGINE_OPEN +
          JSON.stringify({
            sid: SOCKET_SESSION_ID,
            upgrades: [],
            pingInterval: HEARTBEAT_NEVER_DUE_MILLISECONDS,
            pingTimeout: HEARTBEAT_NEVER_DUE_MILLISECONDS,
            maxPayload: Number.MAX_SAFE_INTEGER,
          }),
      );
    }

    private acceptNamespace(): void {
      this.deliver(
        NAMESPACE_CONNECT_REQUEST + JSON.stringify({ sid: SOCKET_SESSION_ID }),
      );
      for (const { event, payload } of eventsOnConnect) {
        this.deliver(
          ENGINE_MESSAGE + SOCKET_EVENT + JSON.stringify([event, payload]),
        );
      }
    }

    private deliver(frame: string): void {
      window.setTimeout(() => this.onmessage?.({ data: frame }));
    }
  }

  window.WebSocket = FakeSocketIoWebSocket as unknown as typeof WebSocket;
}
