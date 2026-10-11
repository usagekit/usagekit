import { createProviderProxy, recoverProxyIntents } from "@usagekit/proxy";
import { localAccess } from "./auth.js";
import { serve } from "@hono/node-server";
import { join } from "node:path";
import type { Server } from "node:http";
import type { Clock } from "@usagekit/store";
import { createSqliteStore } from "@usagekit/store-sqlite";
import { createCatalog, dataforseo, serpapi } from "@usagekit/providers";
import { resolvePricing } from "./pricing.js";
import { createProxyRecorder } from "./proxy-recorder.js";
import { createRecorder } from "./recorder.js";
import { createMeter } from "@usagekit/meter";
import { loadConfig, defaultConfigDir } from "./config.js";
import { createAuth } from "./auth.js";
import { createVault } from "./vault.js";
import { createApp } from "./app.js";
import { defaultUiRoot } from "./ui.js";
import { createProviderManagement } from "./provider-management/service.js";
import { acquireServerLock } from "./server-lock.js";
export type ServerConfig = {
  configDir?: string;
  port?: number;
  host?: string;
  allowRemote?: boolean;
  passphrase?: string;
  clock?: Clock;
  /** Host allowlist; defaults to the two bundled descriptors. */
  enabledProviders?: readonly string[];
  /** Reject paths not advertised by an enabled descriptor. */
  strictProxy?: boolean;
  /** Injectable provider transport; production uses fetch. */
  providerFetch?: typeof fetch;
  onToken?: (token: string) => void;
  /** Directory of the built UI; defaults to dist/ui next to the server. */
  uiRoot?: string;
};
export async function startServer(options: ServerConfig = {}) {
  const host = options.host ?? "127.0.0.1";
  if (!["127.0.0.1", "::1", "localhost"].includes(host))
    throw new Error(options.allowRemote ? "NotSupported: remote TLS" : "LoopbackOnly");
  const configDir = options.configDir ?? defaultConfigDir();
  const release = acquireServerLock(configDir);
  let cleanup = () => {};
  try {
    return await startOwnedServer({ ...options, configDir }, host, release, (next) => {
      cleanup = next;
    });
  } catch (error) {
    try {
      cleanup();
    } finally {
      release();
    }
    throw error;
  }
}

async function startOwnedServer(
  options: ServerConfig,
  host: string,
  release: () => void,
  registerCleanup: (cleanup: () => void) => void,
) {
  const dir = options.configDir ?? defaultConfigDir(),
    loaded = loadConfig(dir),
    auth = createAuth(loaded.config, loaded.path),
    vault = createVault(join(dir, "vault.enc")),
    clock = options.clock ?? { now: () => new Date() };
  registerCleanup(() => vault.lock());
  if (loaded.firstToken)
    (options.onToken ?? ((token) => console.log(`usagekit token (shown once): ${token}`)))(
      loaded.firstToken,
    );
  if (options.passphrase) vault.unlock(options.passphrase);
  const store = createSqliteStore({ path: join(dir, "usage.db"), clock });
  registerCleanup(() => {
    try {
      store.close();
    } finally {
      vault.lock();
    }
  });
  const catalog = createCatalog({
    providers: [dataforseo, serpapi],
    enabled: options.enabledProviders ?? ["dataforseo", "serpapi"],
    now: () => clock.now(),
  });
  const meter = createMeter({
      catalog,
      resolveConnection: ({ namespace, connection }) =>
        namespace === "local"
          ? resolvePricing(connection, { vault, store, catalog, now: clock.now })
          : undefined,
      store,
      clock,
      resolveOwnership: async (scope) =>
        scope.namespace === "local"
          ? { kind: "principal", namespace: "local", principal: "local" }
          : null,
    }),
    app = createApp({
      providerManagement: createProviderManagement({
        store,
        vault,
        catalog,
        now: () => clock.now(),
      }),
      proxy: createProviderProxy({
        meter,
        catalog,
        authenticate: auth.authenticate,
        owner: { namespace: "local", principal: "local" },
        strict: options.strictProxy ?? false,
        transport: options.providerFetch ?? fetch,
        now: () => clock.now(),
        recordFixture: createProxyRecorder({ catalog, dir, now: () => clock.now() }),
        connection(id) {
          const c = vault.list().find((e) => e.connectionId === id);
          return c ? { ...c, secret: vault.get(c.provider, id) } : undefined;
        },
      }),
      catalog,
      record: createRecorder({
        meter,
        catalog,
        vault,
        dir,
        clock,
        transport: options.providerFetch ?? fetch,
      }),
      meter,
      store,
      auth,
      vault,
      configPath: loaded.path,
      uiRoot: options.uiRoot ?? defaultUiRoot,
    });
  let maintenance: Promise<void> | undefined;
  const expireReservations = () =>
    (maintenance ??= (async () => {
      let result;
      do {
        result = await meter.expireReservations({ namespace: "local", limit: 1000 });
        if (result.outcome !== "expired") throw new Error("ReservationCleanupFailed");
      } while (result.hasMore);
      await recoverProxyIntents(meter, localAccess, clock.now());
    })().finally(() => {
      maintenance = undefined;
    }));
  let server: Server;
  try {
    await expireReservations();
    server = await new Promise<Server>((resolve, reject) => {
      const instance = serve({ fetch: app.fetch, hostname: host, port: options.port ?? 4242 }, () =>
        resolve(instance as Server),
      );
      instance.once("error", reject);
    });
  } catch (error) {
    throw error;
  }
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Invalid listen address");
  const sweepTimer = setInterval(() => {
    void expireReservations().catch(() => console.error("usagekit reservation cleanup failed"));
  }, 30000);
  sweepTimer.unref();
  let stopped = false;
  return {
    url: `http://${host.includes(":") ? `[${host}]` : host}:${address.port}`,
    app,
    store,
    vault,
    expireReservations,
    async stop() {
      if (stopped) return;
      stopped = true;
      clearInterval(sweepTimer);
      try {
        await maintenance?.catch(() => {});
        await new Promise<void>((resolve, reject) =>
          server.close((error) => (error ? reject(error) : resolve())),
        );
      } finally {
        try {
          store.close();
        } finally {
          vault.lock();
          release();
        }
      }
    },
  };
}

export type { ConnectionMetadata } from "./vault.js";
export { ServerOwnershipError } from "./server-lock.js";
