"use client";
import type { ComponentProps } from "react";
import { Input } from "@/components/ui/input";

export type CredentialInputProps = Omit<
  ComponentProps<typeof Input>,
  "type" | "autoComplete" | "spellCheck" | "autoCapitalize" | "autoCorrect"
>;

/** Presentational only: no storage, validation, requests or credential lifecycle.
 * Hosts own the accessible label, lifetime and analytics configuration. Masking
 * attributes are defense in depth, not a guarantee that all recorders omit input. */
export function CredentialInput({ className, ...props }: CredentialInputProps) {
  return (
    <Input
      {...props}
      type="password"
      autoComplete="off"
      spellCheck={false}
      autoCapitalize="none"
      autoCorrect="off"
      data-private="true"
      data-ph-mask="true"
      className={["ph-no-capture", className].filter(Boolean).join(" ")}
    />
  );
}
