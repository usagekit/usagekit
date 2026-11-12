import type { Budget } from "@usagekit/core";
import type { Store, ManualClock } from "../src/index.js";
export type StoreCapabilities = {
  durable: boolean;
  rollingWindows: boolean;
  maxMoneyUnits: bigint;
  maxQuantityScale: number;
};
export type StoreFixture = {
  store: Store;
  clock: ManualClock;
  budgets: Budget[];
  close(): Promise<void>;
  /** Persistent adapters must terminate and reopen their backing process here. */
  restart?: () => Promise<Store>;
  replayMoneyMigration?: () => Promise<void>;
  moneyColumns?: () => Promise<{ cost_units: string; cost_scale: number }[]>;
};
export type StoreFactory = () => Promise<StoreFixture>;
