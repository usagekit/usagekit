import { useEffect, useLayoutEffect, useMemo, useRef } from "react";
import type {
  ProviderActionResult,
  ProviderCommand,
  ProviderQuery,
  ProviderSnapshot,
  ProviderSnapshotOf,
} from "@usagekit/views";
import { useCallbackFence } from "./callback-fence.js";
import { identity, serialize } from "./keys.js";
import { useProviderAction } from "./provider-action.js";
import type { ProviderAction } from "./provider-action.js";
import { providerActionEntry } from "./provider-action-state.js";
import type { ProviderActionEntry } from "./provider-action-state.js";
import { retainProviderCommand } from "./provider-command.js";
import { useProviderManagementBinding } from "./provider-context.js";
import { useProviderRead } from "./provider-hooks.js";
import type { ProviderHookBinding, ProviderViewResult } from "./provider-hooks.js";
import { defaultProviderQueryClient, providerBindingKey } from "./provider-read-client.js";

// The journal owns the immutable command. Only its editor origin is retained here, never credentials.
const commandOrigins = new WeakMap<ProviderActionEntry, { key: string; commandId: string }>();

export type ProviderEditorRefreshKind = "reload" | "revalidate" | null;
export type ProviderEditorOptions<K extends ProviderQuery["kind"]> = ProviderHookBinding & {
  /** Called once after a successful explicit Reload has rebased this editor. */
  onRebase?: (snapshot: ProviderSnapshotOf<K>) => void;
  /** Reports null on refresh completion, editor identity replacement or unmount. */
  onReadRefreshChange?: (kind: ProviderEditorRefreshKind) => void;
};

export type ProviderEditor<K extends ProviderQuery["kind"]> = Omit<
  ProviderViewResult<K>,
  "data" | "refresh"
> & {
  /** Current display evidence. Never render financial figures from editorData. */
  evidence: ProviderSnapshotOf<K> | null;
  /** Retained draft initializer and CAS base, not current financial evidence or authorization. */
  editorData: ProviderSnapshotOf<K> | null;
  /** Reset a host's local draft when this opaque identity changes. */
  editorEpoch: string;
  canEdit: boolean;
  action: ProviderAction;
  /** Background reads do not require a host to block dismissal. */
  refreshKind: ProviderEditorRefreshKind;
  /** Rebase only after this explicit read succeeds. Pending/ambiguous commands prevent reload. */
  reload(): void;
};

/** Separates a draft's base from live evidence without owning form state, fetching or host authorization. */
export function useProviderEditor<K extends ProviderQuery["kind"]>(
  query: Extract<ProviderQuery, { kind: K }>,
  options: ProviderEditorOptions<K> = {},
): ProviderEditor<K> {
  const onReadRefreshChange = useRef(options.onReadRefreshChange);
  useLayoutEffect(() => {
    onReadRefreshChange.current = options.onReadRefreshChange;
  }, [options.onReadRefreshChange]);
  const inherited = useProviderManagementBinding();
  const port = options.port ?? inherited?.port,
    binding = options.binding ?? inherited?.binding;
  const client =
    options.client ?? inherited?.client ?? (port ? defaultProviderQueryClient(port) : null);
  const key = `${client ? identity(client) : "missing"}:${port && binding ? providerBindingKey(port, binding) : "missing"}:${serialize(query)}`;
  const isCurrent = useCallbackFence(key);
  const read = useProviderRead<K>(query, options);
  const action = useProviderAction(options);
  const entry = useMemo(
    () => (port && binding && client ? client.entry(port, binding, query) : null),
    [key],
  );
  const journal =
    port && binding
      ? providerActionEntry(serialize([binding.scopeKey, binding.principalKey]))
      : null;
  const editor = useMemo(
    () => ({
      base: null as ProviderSnapshotOf<K> | null,
      epoch: 0,
      notifiedEpoch: 0,
      notifiedRefreshKind: undefined as ProviderEditorRefreshKind | undefined,
      reload: null as number | null,
      fence: null as "forbidden" | "conflict" | null,
      acknowledged: null as ProviderActionResult | null,
      commandId: null as string | null,
    }),
    [key],
  );
  const origin = journal ? commandOrigins.get(journal) : undefined;
  if (
    origin?.key === key &&
    origin.commandId === journal?.command?.commandId &&
    (action.pending || action.ambiguous)
  )
    editor.commandId = origin.commandId;
  // Read the shared journal synchronously: a sibling editor may have refused or started a command.
  const updateFence = () => {
    const result = journal?.snapshot.result;
    if (result && result !== editor.acknowledged) {
      if (result.outcome === "forbidden" && !journal?.snapshot.ambiguous)
        editor.fence = "forbidden";
      else if (result.outcome === "conflict" && !editor.fence) editor.fence = "conflict";
    }
  };
  updateFence();
  if (editor.reload !== null && entry) {
    // A newer read, such as an access or focus refresh, also started after the request and answers it.
    if (entry.generation < editor.reload) editor.reload = null;
    else if (!entry.running) {
      editor.reload = null;
      if (
        !journal?.snapshot.pending &&
        !journal?.snapshot.ambiguous &&
        read.data &&
        (read.state === "ok" || read.state === "empty")
      ) {
        editor.base = read.data;
        editor.epoch++;
        editor.fence = null;
        editor.acknowledged = journal?.snapshot.result ?? null;
        editor.commandId = null;
      }
    }
  }
  if (!editor.base && read.data) editor.base = read.data;
  const rebaseEpoch = editor.epoch;
  useEffect(() => {
    if (!isCurrent() || editor.notifiedEpoch === rebaseEpoch || !editor.base) return;
    editor.notifiedEpoch = rebaseEpoch;
    options.onRebase?.(editor.base);
  }, [editor, rebaseEpoch, options.onRebase, isCurrent]);
  const refreshKind: ProviderEditorRefreshKind =
    editor.reload !== null
      ? "reload"
      : entry?.snapshot.fetching && editor.base
        ? "revalidate"
        : null;
  useEffect(() => {
    if (!isCurrent() || editor.notifiedRefreshKind === refreshKind) return;
    editor.notifiedRefreshKind = refreshKind;
    options.onReadRefreshChange?.(refreshKind);
  }, [editor, options.onReadRefreshChange, refreshKind, isCurrent]);
  useEffect(
    () => () => {
      if (editor.notifiedRefreshKind != null) onReadRefreshChange.current?.(null);
      editor.notifiedRefreshKind = undefined;
    },
    [editor],
  );
  const eligible = () => {
    updateFence();
    const current = entry?.snapshot;
    return (
      isCurrent() &&
      binding?.canManage === true &&
      !editor.fence &&
      !journal?.snapshot.pending &&
      !journal?.snapshot.ambiguous &&
      !!current &&
      !current.fetching &&
      !!current.data &&
      !!editor.base &&
      hasTarget(current.data)
    );
  };
  const reload = () => {
    if (
      !isCurrent() ||
      !entry ||
      !client ||
      journal?.snapshot.pending ||
      journal?.snapshot.ambiguous
    )
      return;
    editor.reload = entry.generation + 1;
    client.refresh(entry);
  };
  const run: ProviderAction["run"] = async (input, secrets) => {
    const commandId =
      input && typeof input === "object"
        ? Object.getOwnPropertyDescriptor(input, "commandId")?.value
        : "";
    const denied: ProviderActionResult = {
      outcome: "forbidden",
      commandId: typeof commandId === "string" ? commandId : "",
    };
    if (!eligible()) return denied;
    const retained = retainProviderCommand(input);
    if (!("command" in retained))
      return { outcome: "invalid", commandId: denied.commandId, ...retained };
    if (
      !editor.base ||
      !entry?.snapshot.data ||
      !matchesCommand(retained.command, editor.base, entry.snapshot.data)
    )
      return denied;
    const running = action.run(retained.command, secrets);
    if (
      journal?.command?.commandId === retained.command.commandId &&
      serialize(journal.command) === serialize(retained.command)
    ) {
      editor.commandId = retained.command.commandId;
      commandOrigins.set(journal, { key, commandId: retained.command.commandId });
    }
    return running;
  };
  const visibleCommand =
    editor.commandId !== null && editor.commandId === action.submittedCommand?.commandId;
  return {
    state: editor.fence === "forbidden" ? "forbidden" : read.state,
    error: editor.fence === "forbidden" ? null : read.error,
    refreshing: read.refreshing,
    refreshKind,
    evidence: editor.fence === "forbidden" ? null : read.data,
    editorData: editor.base,
    editorEpoch: `${identity(editor)}:${editor.epoch}`,
    canEdit: eligible(),
    reload,
    action: {
      ...action,
      state: visibleCommand
        ? action.state
        : action.pending || action.ambiguous
          ? "unavailable"
          : "idle",
      result: visibleCommand ? action.result : null,
      submittedCommand: visibleCommand ? action.submittedCommand : null,
      canWrite: eligible(),
      run,
      reconcile: () =>
        isCurrent()
          ? action.reconcile()
          : Promise.resolve({ outcome: "forbidden", commandId: journal?.command?.commandId ?? "" }),
      reset: () => {
        updateFence();
        if (
          isCurrent() &&
          !editor.fence &&
          !journal?.snapshot.pending &&
          !journal?.snapshot.ambiguous
        )
          action.reset();
      },
    },
  };
}

function hasTarget(snapshot: ProviderSnapshot): boolean {
  if (snapshot.kind === "connections")
    return !!(snapshot.connections.length || snapshot.providers.length);
  if (snapshot.kind === "details")
    return !!snapshot.connection?.capabilities.some(
      (kind) => kind !== "connect" && kind !== "allocations",
    );
  if (snapshot.kind === "allocations") return !!snapshot.rows.length;
  return false;
}
function connection(snapshot: ProviderSnapshot, id: string) {
  if (snapshot.kind === "connections") return snapshot.connections.find((row) => row.id === id);
  if (snapshot.kind === "details" && snapshot.connection?.id === id) return snapshot.connection;
  return undefined;
}
/** Local target/CAS safety only; each command remains independently authorized by the host. */
function matchesCommand(
  command: ProviderCommand,
  base: ProviderSnapshot,
  current: ProviderSnapshot,
): boolean {
  // A list composes independently selected editors. New/current targets may postdate its draft base.
  if (base.kind === "connections" && current.kind === "connections") {
    if ("connectionId" in command) {
      const fresh = connection(current, command.connectionId);
      if (!fresh?.capabilities.includes(command.kind)) return false;
      return (
        command.kind !== "rates" ||
        command.rates.every((rate) =>
          fresh.rates.some((item) => item.id === rate.rateId && item.editable),
        )
      );
    }
    return (
      "provider" in command &&
      current.providers.some(
        (row) => row.id === command.provider && row.capabilities.includes(command.kind),
      )
    );
  }
  if (command.kind === "allocations") {
    if (
      base.kind !== "allocations" ||
      current.kind !== "allocations" ||
      command.expectedRevision !== base.revision
    )
      return false;
    return command.changes.every((change) => {
      const row = base.rows.find((row) => row.id === change.rowId);
      return (
        !!row?.editable &&
        row.revision === change.expectedRevision &&
        current.rows.some((fresh) => fresh.id === row.id && fresh.editable)
      );
    });
  }
  if ("connectionId" in command) {
    const row = connection(base, command.connectionId),
      fresh = connection(current, command.connectionId);
    if (
      !row ||
      !fresh ||
      !fresh.capabilities.includes(command.kind) ||
      row.revision !== command.expectedRevision
    )
      return false;
    if (command.kind === "rates")
      return command.rates.every(
        (rate) =>
          row.rates.some((item) => item.id === rate.rateId && item.editable) &&
          fresh.rates.some((item) => item.id === rate.rateId && item.editable),
      );
    return true;
  }
  return false;
}
