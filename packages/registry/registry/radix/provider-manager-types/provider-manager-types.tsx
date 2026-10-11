import type { ComponentProps } from "react";
import type { ProviderCard } from "@/components/usagekit/provider-card";
import type { ProviderConnectForm } from "@/components/usagekit/provider-connect-form";
import type { ProviderSourceSelector } from "@/components/usagekit/provider-source-selector";
import type { ProviderRateEditor } from "@/components/usagekit/provider-rate-editor";
import type { ProviderChainEditor } from "@/components/usagekit/provider-chain-editor";
import type { ProviderBalancePanel } from "@/components/usagekit/provider-balance-card";
import type { ProviderAllocationPanel } from "@/components/usagekit/provider-allocation-editor";
export type ProviderManagerChildProps = {
  card?: Partial<
    Omit<ComponentProps<typeof ProviderCard>, "connection" | "action" | "onManage" | "selected">
  >;
  connect?: Partial<
    Omit<
      ComponentProps<typeof ProviderConnectForm>,
      "provider" | "connection" | "action" | "onConnected"
    >
  >;
  source?: Partial<
    Omit<
      ComponentProps<typeof ProviderSourceSelector>,
      "mode" | "connection" | "action" | "sources"
    >
  >;
  rate?: Partial<
    Omit<ComponentProps<typeof ProviderRateEditor>, "connection" | "evidence" | "action">
  >;
  chain?: Partial<
    Omit<
      ComponentProps<typeof ProviderChainEditor>,
      "mode" | "connection" | "connections" | "action"
    >
  >;
  balance?: Partial<Omit<ComponentProps<typeof ProviderBalancePanel>, "connectionId">>;
  allocation?: Partial<
    Omit<
      ComponentProps<typeof ProviderAllocationPanel>,
      "connectionIds" | "evidenceAvailable" | "canEdit"
    >
  >;
};
