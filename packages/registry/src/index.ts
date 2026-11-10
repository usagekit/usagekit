/** Block names of the usagekit shadcn registry, in index order. Sources live under registry/. */
export const blockNames = [
  "usage-table",
  "budget-card",
  "header-status",
  "coverage-summary",
  "exceptions-list",
  "usage-filters",
  "connection-list",
  "measurement-card",
  "usage-summary-cards",
  "cost-summary-card",
  "budget-editor",
  "budget-manager-panel",
  "provider-card",
  "provider-connect-form",
  "provider-source-selector",
  "provider-rate-editor",
  "provider-chain-editor",
  "provider-balance-card",
  "provider-allocation-editor",
  "provider-manager-panel",
  "usage-overview-card",
  "usage-cap-pill",
  "credential-input",
] as const;
export type BlockName = (typeof blockNames)[number];
export const variants = ["radix", "base"] as const;
export type Variant = (typeof variants)[number];
/** Blocks whose primitive API differs between Radix and Base UI; the others share one file. */
export const variantSpecific: readonly BlockName[] = ["header-status", "usage-filters"];
