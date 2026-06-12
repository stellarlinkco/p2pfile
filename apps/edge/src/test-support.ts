import { ClaimSessionResponseSchema, type FileManifestItem } from "@p2pfile/shared";
import { type EdgeEnv, handleRequest, SessionDirectory, SessionDurableObject } from "./index";

export { type EdgeEnv, handleRequest };

export const spaShell = '<!doctype html><html><body><div id="root"></div></body></html>';
export const manifest: FileManifestItem[] = [
  { id: "local-1", name: "notes-alpha.txt", size: 27, mimeType: "text/plain" },
  { id: "local-2", name: "notes-beta.json", size: 23, mimeType: "application/json" },
];

export type StorageMutation = { key: string; value: unknown } | { key: string; deleted: true };

export class MemoryDurableObjectStorage {
  private readonly values = new Map<string, unknown>();
  private alarmAt: number | null = null;

  constructor(private readonly onMutation: (mutation: StorageMutation) => void = () => undefined) {}

  get<T>(key: string) {
    return Promise.resolve(this.values.get(key) as T | undefined);
  }

  put(key: string, value: unknown) {
    this.values.set(key, value);
    this.onMutation({ key, value });
    return Promise.resolve();
  }

  delete(key: string) {
    this.onMutation({ key, deleted: true });
    return Promise.resolve(this.values.delete(key));
  }

  setAlarm(scheduledTime: number) {
    this.alarmAt = scheduledTime;
    return Promise.resolve();
  }

  getAlarm() {
    return Promise.resolve(this.alarmAt);
  }

  deleteAlarm() {
    this.alarmAt = null;
    return Promise.resolve();
  }
}

export class MemoryDurableObjectNamespace<
  T extends { fetch(request: Request): Response | Promise<Response> },
> {
  private readonly instances = new Map<string, T>();
  private readonly storages = new Map<string, MemoryDurableObjectStorage>();

  constructor(
    private readonly create: (state: DurableObjectState) => T,
    private readonly onStorageMutation: (mutation: StorageMutation) => void = () => undefined,
  ) {}

  idFromName(name: string) {
    return name as unknown as DurableObjectId;
  }

  get(id: DurableObjectId) {
    const key = String(id);
    return this.instanceForKey(key) as unknown as DurableObjectStub;
  }

  storageForName(name: string) {
    return this.storageForKey(name);
  }

  instanceForName(name: string) {
    return this.instanceForKey(name);
  }

  private instanceForKey(key: string) {
    let instance = this.instances.get(key);
    if (!instance) {
      instance = this.create({ storage: this.storageForKey(key) } as unknown as DurableObjectState);
      this.instances.set(key, instance);
    }
    return instance;
  }

  private storageForKey(key: string) {
    let storage = this.storages.get(key);
    if (!storage) {
      storage = new MemoryDurableObjectStorage(this.onStorageMutation);
      this.storages.set(key, storage);
    }
    return storage;
  }
}

export function createDurableObjects() {
  return {
    SESSION_OBJECT: new MemoryDurableObjectNamespace(
      (state) => new SessionDurableObject(state),
    ) as unknown as DurableObjectNamespace,
    SESSION_DIRECTORY: new MemoryDurableObjectNamespace(
      (state) => new SessionDirectory(state),
    ) as unknown as DurableObjectNamespace,
  };
}

export function createDurableObjectsWithStorageTrace(mutations: StorageMutation[]) {
  const traceMutation = (mutation: StorageMutation) => mutations.push(mutation);
  return {
    SESSION_OBJECT: new MemoryDurableObjectNamespace(
      (state) => new SessionDurableObject(state),
      traceMutation,
    ) as unknown as DurableObjectNamespace,
    SESSION_DIRECTORY: new MemoryDurableObjectNamespace(
      (state) => new SessionDirectory(state),
      traceMutation,
    ) as unknown as DurableObjectNamespace,
  };
}

const durableObjects = createDurableObjects();

export function createEnv(
  bindings: Pick<EdgeEnv, "SESSION_OBJECT" | "SESSION_DIRECTORY"> = durableObjects,
): EdgeEnv {
  return {
    ASSETS: {
      fetch: async (request: Request) => {
        const url = new URL(request.url);
        if (url.pathname === "/" || url.pathname === "/receive" || url.pathname.startsWith("/f/")) {
          return new Response(spaShell, { headers: { "content-type": "text/html" } });
        }
        return new Response("asset missing", { status: 404 });
      },
    },
    ...bindings,
  };
}

export function request(path: string, init?: RequestInit) {
  return new Request(`http://edge.test${path}`, init);
}

export class FakeEdgeWebSocket extends EventTarget {
  readyState: number = WebSocket.OPEN;
  peer: FakeEdgeWebSocket | null = null;
  readonly received: string[] = [];
  closed: { code: number; reason: string } | null = null;

  accept() {
    this.readyState = WebSocket.OPEN;
  }

  send(data: string) {
    this.peer?.receive(data);
  }

  private receive(data: string) {
    this.received.push(data);
    this.dispatchEvent(new MessageEvent("message", { data }));
  }

  close(code = 1000, reason = "") {
    this.readyState = WebSocket.CLOSED;
    this.closed = { code, reason };
    this.dispatchEvent(new CloseEvent("close", { code, reason }));
    if (this.peer && this.peer.readyState !== WebSocket.CLOSED) {
      this.peer.readyState = WebSocket.CLOSED;
      this.peer.closed = { code, reason };
      this.peer.dispatchEvent(new CloseEvent("close", { code, reason }));
    }
  }
}

export function installFakeWebSocketPair() {
  const pairs: Array<{ client: FakeEdgeWebSocket; server: FakeEdgeWebSocket }> = [];
  class FakeWebSocketPair {
    readonly 0: FakeEdgeWebSocket;
    readonly 1: FakeEdgeWebSocket;

    constructor() {
      this[0] = new FakeEdgeWebSocket();
      this[1] = new FakeEdgeWebSocket();
      this[0].peer = this[1];
      this[1].peer = this[0];
      pairs.push({ client: this[0], server: this[1] });
    }
  }
  Object.assign(globalThis, { WebSocketPair: FakeWebSocketPair });
  return pairs;
}

export function websocketRequest(path: string) {
  return request(path, { headers: { upgrade: "websocket" } });
}

export async function claimReceiver(env: EdgeEnv, sessionId: string) {
  const response = await handleRequest(
    request(`/api/sessions/${sessionId}/claim`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({}),
    }),
    env,
  );
  const body = ClaimSessionResponseSchema.parse(await response.json());
  if (body.status !== "claimed") throw new Error("expected claimed session");
  return body;
}

export async function createSession(env = createEnv()) {
  const response = await handleRequest(
    request("/api/sessions", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        manifest: manifest.map((item) => ({
          ...item,
          bytes: "alpha file from playwright",
          thumbnailUrl: "r2://forbidden-preview",
          stagedUploadId: "forbidden-staged-upload",
        })),
      }),
    }),
    env,
  );
  return { response, body: await response.json() };
}
