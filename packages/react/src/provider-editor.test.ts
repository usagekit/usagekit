import { act, cleanup, render, renderHook, waitFor } from "@testing-library/react";
import { afterEach, expect, test, vi } from "vitest";
import { createElement, startTransition, Suspense, useState } from "react";
import type {
  ProviderActionResult,
  ProviderBinding,
  ProviderCommand,
  ProviderManagementPort,
  ProviderQuery,
  ProviderReadResult,
} from "@usagekit/views";
import { createProviderQueryClient, useProviderAction, useProviderEditor } from "./index.js";
import type { ProviderQueryClient } from "./index.js";

afterEach(cleanup);
let fixtureId = 0;
type Input = {
  binding: ProviderBinding;
  port: ProviderManagementPort;
  client: ProviderQueryClient;
  query: Extract<ProviderQuery, { kind: "details" }>;
};
function details(
  revision = "1",
  price = "1.2345",
  connectionId = "connection-a",
): ProviderReadResult {
  return {
    outcome: "ok",
    value: {
      kind: "details",
      state: "ok",
      problem: null,
      asOf: null,
      revision,
      connection: {
        id: connectionId,
        provider: "search",
        label: "Search",
        revision,
        fundingSource: "byok",
        enabled: true,
        priority: 1,
        fallbackChain: [],
        plan: null,
        status: { state: "connected" },
        availability: { state: "unknown" },
        freshness: { source: "unknown", observedAt: null, stale: true },
        capabilities: ["rates"],
        hasStoredCredentials: true,
        rates: [
          {
            id: "search",
            label: "Search",
            operation: "search",
            unit: "requests",
            priceUnit: "cents",
            price: { text: price, unit: "cents", certainty: "measured" },
            fundingSource: "byok",
            editable: true,
            provenance: {
              source: "manual",
              origin: "host",
              checkedAt: null,
              sampleSize: null,
              version: null,
            },
          },
        ],
      },
    },
  };
}
function command(commandId = "draft", expectedRevision = "1"): ProviderCommand {
  return {
    kind: "rates",
    commandId,
    connectionId: "connection-a",
    expectedRevision,
    rates: [{ rateId: "search", price: "0" }],
  };
}
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}
function fixture() {
  const read = vi.fn(
    async (_binding: ProviderBinding, query: ProviderQuery): Promise<ProviderReadResult> =>
      details("1", "1.2345", query.kind === "details" ? query.connectionId : "connection-a"),
  );
  const execute = vi.fn(
    async (_binding: ProviderBinding, input: ProviderCommand): Promise<ProviderActionResult> => ({
      outcome: "success",
      commandId: input.commandId,
      revision: "2",
    }),
  );
  const reconcile = vi.fn(
    async (_binding: ProviderBinding, input: ProviderCommand): Promise<ProviderActionResult> => ({
      outcome: "success",
      commandId: input.commandId,
      revision: "2",
    }),
  );
  const input: Input = {
    binding: {
      scopeKey: `editor:${++fixtureId}`,
      principalKey: "owner",
      authRevision: "1",
      canManage: true,
    },
    port: { read, execute, reconcile },
    client: createProviderQueryClient(),
    query: { kind: "details", connectionId: "connection-a" },
  };
  return { input, read, execute, reconcile };
}
const useEditor = (input: Input) => useProviderEditor(input.query, input);

test("read refresh notifications ignore inline callback identity", async () => {
  const f = fixture();
  const notify = vi.fn();
  const { result, rerender } = renderHook(() =>
    useProviderEditor(f.input.query, {
      ...f.input,
      onReadRefreshChange: (kind) => notify(kind),
    }),
  );
  await waitFor(() => expect(result.current.canEdit).toBe(true));
  expect(notify).toHaveBeenCalledWith(null);
  notify.mockClear();
  rerender();
  expect(notify).not.toHaveBeenCalled();

  const background = deferred<ProviderReadResult>();
  f.read.mockReturnValueOnce(background.promise);
  act(() => f.input.client.invalidate(f.input.port, f.input.binding));
  expect(notify.mock.calls).toEqual([["revalidate"]]);
  rerender();
  expect(notify.mock.calls).toEqual([["revalidate"]]);
  await act(async () => background.resolve(details("2")));
  expect(notify.mock.calls).toEqual([["revalidate"], [null]]);

  const explicit = deferred<ProviderReadResult>();
  f.read.mockReturnValueOnce(explicit.promise);
  act(() => result.current.reload());
  expect(notify.mock.calls).toEqual([["revalidate"], [null], ["reload"]]);
  rerender();
  expect(notify.mock.calls).toEqual([["revalidate"], [null], ["reload"]]);
  await act(async () => explicit.resolve(details("3")));
  expect(notify.mock.calls).toEqual([["revalidate"], [null], ["reload"], [null]]);
});

test.each(["reload", "revalidate"] as const)(
  "unmount clears %s through the latest read refresh callback",
  async (kind) => {
    const f = fixture();
    const first = vi.fn();
    const latest = vi.fn();
    const { result, rerender, unmount } = renderHook(
      ({ notify }) => useProviderEditor(f.input.query, { ...f.input, onReadRefreshChange: notify }),
      { initialProps: { notify: first } },
    );
    await waitFor(() => expect(result.current.canEdit).toBe(true));
    const pending = deferred<ProviderReadResult>();
    f.read.mockReturnValueOnce(pending.promise);
    act(() => {
      if (kind === "reload") result.current.reload();
      else f.input.client.invalidate(f.input.port, f.input.binding);
    });
    expect(first).toHaveBeenLastCalledWith(kind);
    rerender({ notify: latest });
    expect(latest).not.toHaveBeenCalled();
    unmount();
    expect(latest.mock.calls).toEqual([[null]]);
    expect(first).toHaveBeenLastCalledWith(kind);
    await act(async () => pending.resolve(details("2")));
    expect(latest.mock.calls).toEqual([[null]]);
  },
);

test("unmount releases the committed refresh fence after a discarded concurrent render", async () => {
  const f = fixture();
  const committed = vi.fn();
  const abandoned = vi.fn();
  const attempted = vi.fn();
  const suspended = deferred<void>();
  let change!: () => void;
  function Editor({ discard }: { discard: boolean }) {
    useProviderEditor(f.input.query, {
      ...f.input,
      onReadRefreshChange: discard ? abandoned : committed,
    });
    if (discard) {
      attempted();
      throw suspended.promise;
    }
    return null;
  }
  function Host() {
    const [discard, setDiscard] = useState(false);
    change = () => setDiscard(true);
    return createElement(Suspense, { fallback: null }, createElement(Editor, { discard }));
  }
  const view = render(createElement(Host));
  await waitFor(() => expect(committed).toHaveBeenCalledWith(null));
  const pending = deferred<ProviderReadResult>();
  f.read.mockReturnValueOnce(pending.promise);
  act(() => f.input.client.invalidate(f.input.port, f.input.binding));
  expect(committed).toHaveBeenLastCalledWith("revalidate");
  act(() => startTransition(change));
  await waitFor(() => expect(attempted).toHaveBeenCalled());
  expect(abandoned).not.toHaveBeenCalled();
  view.unmount();
  expect(committed).toHaveBeenLastCalledWith(null);
  expect(abandoned).not.toHaveBeenCalled();
  await act(async () => {
    suspended.resolve();
    pending.resolve(details("2"));
  });
});

test.each(["binding", "query"] as const)(
  "read refresh notifications report the new %s identity even when the kind is unchanged",
  async (change) => {
    const f = fixture();
    const notify = vi.fn();
    const { result, rerender } = renderHook(
      (input: Input) => useProviderEditor(input.query, { ...input, onReadRefreshChange: notify }),
      { initialProps: f.input },
    );
    await waitFor(() => expect(result.current.canEdit).toBe(true));
    expect(notify.mock.calls).toEqual([[null]]);
    const next: Input = {
      ...f.input,
      ...(change === "binding"
        ? { binding: { ...f.input.binding, authRevision: "2" } }
        : { query: { kind: "details", connectionId: "connection-b" } }),
    };
    rerender(next);
    await waitFor(() => expect(result.current.canEdit).toBe(true));
    expect(notify.mock.calls).toEqual([[null], [null]]);
    rerender(next);
    expect(notify.mock.calls).toEqual([[null], [null]]);
  },
);

test("public reload signal distinguishes revalidation and reports only confirmed rebases", async () => {
  const f = fixture();
  const onRebase = vi.fn();
  const { result } = renderHook(() => useProviderEditor(f.input.query, { ...f.input, onRebase }));
  await waitFor(() => expect(result.current.canEdit).toBe(true));
  expect(onRebase).not.toHaveBeenCalled();
  const background = deferred<ProviderReadResult>();
  f.read.mockReturnValueOnce(background.promise);
  act(() => f.input.client.invalidate(f.input.port, f.input.binding));
  expect(result.current.refreshKind).toBe("revalidate");
  await act(async () => background.resolve(details("2")));
  expect(result.current.refreshKind).toBeNull();
  expect(onRebase).not.toHaveBeenCalled();
  const explicit = deferred<ProviderReadResult>();
  f.read.mockReturnValueOnce(explicit.promise);
  act(() => result.current.reload());
  expect(result.current.refreshKind).toBe("reload");
  await act(async () => explicit.resolve(details("3")));
  expect(result.current.refreshKind).toBeNull();
  expect(onRebase).toHaveBeenCalledExactlyOnceWith(result.current.editorData);
  f.read.mockResolvedValueOnce({ outcome: "unavailable", message: "offline" });
  act(() => result.current.reload());
  await waitFor(() => expect(result.current.state).toBe("unavailable"));
  expect(result.current.refreshKind).toBeNull();
  const recovery = deferred<ProviderReadResult>();
  f.read.mockReturnValueOnce(recovery.promise);
  act(() => f.input.client.invalidate(f.input.port, f.input.binding));
  expect(result.current.refreshKind).toBe("revalidate");
  await act(async () => recovery.resolve(details("4")));
  await waitFor(() => expect(result.current.evidence?.revision).toBe("4"));
  expect(onRebase).toHaveBeenCalledTimes(1);
  expect(result.current.editorData?.revision).toBe("3");
  // An unchanged revision still confirms a new explicit rebase.
  f.read.mockResolvedValueOnce(details("3"));
  act(() => result.current.reload());
  await waitFor(() => expect(onRebase).toHaveBeenCalledTimes(2));
});

test("a captured writer is fenced immediately when the live cache starts refreshing", async () => {
  const f = fixture(),
    next = deferred<ProviderReadResult>();
  const { result } = renderHook(() => useEditor(f.input));
  await waitFor(() => expect(result.current.canEdit).toBe(true));
  const run = result.current.action.run;
  f.read.mockReturnValueOnce(next.promise);
  let answer!: Promise<ProviderActionResult>;
  act(() => {
    f.input.client.invalidate(f.input.port, f.input.binding);
    answer = run(command());
  });
  await expect(answer).resolves.toMatchObject({ outcome: "forbidden" });
  expect(f.execute).not.toHaveBeenCalled();
  await act(async () => {
    next.resolve(details());
  });
});

test("a sibling editor's execute denial fences an already captured writer", async () => {
  const f = fixture();
  f.execute.mockImplementationOnce(async (_binding, input) => ({
    outcome: "forbidden",
    commandId: input.commandId,
  }));
  const first = renderHook(() => useEditor(f.input));
  const second = renderHook(() => useEditor(f.input));
  await waitFor(() => expect(second.result.current.canEdit).toBe(true));
  const run = second.result.current.action.run;
  await act(async () => {
    await first.result.current.action.run(command());
    expect((await run(command("second"))).outcome).toBe("forbidden");
  });
  expect(f.execute).toHaveBeenCalledTimes(1);
  expect(second.result.current.evidence).toBeNull();
});

test.each(["forbidden", "unavailable"] as const)(
  "separates retained editor base from %s evidence and background recovery",
  async (outcome) => {
    const f = fixture();
    const { result } = renderHook(() => useEditor(f.input));
    await waitFor(() => expect(result.current.canEdit).toBe(true));
    const base = result.current.editorData,
      epoch = result.current.editorEpoch;
    const staleRun = result.current.action.run;
    const read = deferred<ProviderReadResult>();
    f.read.mockReturnValueOnce(read.promise);
    act(() => f.input.client.invalidate(f.input.port, f.input.binding));
    expect(result.current.refreshing).toBe(true);
    expect(result.current.evidence).toBe(base);
    expect(result.current.canEdit).toBe(false);
    await act(async () => {
      read.resolve(outcome === "forbidden" ? { outcome } : { outcome, message: "Unavailable" });
    });
    await waitFor(() => expect(result.current.state).toBe(outcome));
    expect(result.current).toMatchObject({
      evidence: null,
      editorData: base,
      editorEpoch: epoch,
      canEdit: false,
    });
    await act(async () => {
      expect((await staleRun(command())).outcome).toBe("forbidden");
    });
    expect(f.execute).not.toHaveBeenCalled();
    f.read.mockResolvedValueOnce(details("2", "9.8765"));
    act(() => f.input.client.invalidate(f.input.port, f.input.binding));
    await waitFor(() => expect(result.current.evidence?.revision).toBe("2"));
    expect(result.current.editorData).toBe(base);
    expect(result.current.editorEpoch).toBe(epoch);
    expect(result.current.canEdit).toBe(true);
    f.read.mockResolvedValueOnce(details("3", "8.7654"));
    act(() => result.current.reload());
    await waitFor(() => expect(result.current.editorData?.revision).toBe("3"));
    expect(result.current.editorEpoch).not.toBe(epoch);
    expect(f.execute).not.toHaveBeenCalled();
  },
);

test.each(["forbidden", "unavailable"] as const)(
  "consumes a failed explicit %s reload before later background recovery",
  async (outcome) => {
    const f = fixture();
    const { result } = renderHook(() => useEditor(f.input));
    await waitFor(() => expect(result.current.canEdit).toBe(true));
    const base = result.current.editorData,
      epoch = result.current.editorEpoch;
    f.read.mockResolvedValueOnce(
      outcome === "forbidden" ? { outcome } : { outcome, message: "Unavailable" },
    );
    act(() => result.current.reload());
    await waitFor(() => expect(result.current.state).toBe(outcome));
    expect(result.current.editorData).toBe(base);
    expect(result.current.editorEpoch).toBe(epoch);
    f.read.mockResolvedValueOnce(details("2"));
    act(() => f.input.client.invalidate(f.input.port, f.input.binding));
    await waitFor(() => expect(result.current.evidence?.revision).toBe("2"));
    expect(result.current.editorData).toBe(base);
    expect(result.current.editorEpoch).toBe(epoch);
  },
);

test.each(["scope", "principal", "authRevision", "permission", "port", "client", "query"] as const)(
  "isolates %s changes immediately and fences old callbacks and delayed replies",
  async (change) => {
    const f = fixture();
    const { result, rerender } = renderHook(useEditor, { initialProps: f.input });
    await waitFor(() => expect(result.current.canEdit).toBe(true));
    const epoch = result.current.editorEpoch,
      oldReload = result.current.reload,
      oldRun = result.current.action.run;
    const old = deferred<ProviderReadResult>(),
      current = deferred<ProviderReadResult>();
    f.read.mockReturnValueOnce(old.promise).mockReturnValueOnce(current.promise);
    act(() => f.input.client.invalidate(f.input.port, f.input.binding));
    const next: Input = { ...f.input, binding: { ...f.input.binding } };
    if (change === "scope") next.binding.scopeKey += ":next";
    if (change === "principal") next.binding.principalKey = "reader";
    if (change === "authRevision") next.binding.authRevision = "2";
    if (change === "permission") next.binding.canManage = false;
    if (change === "port") next.port = { ...next.port };
    if (change === "client") next.client = createProviderQueryClient();
    if (change === "query") next.query = { kind: "details", connectionId: "connection-b" };
    rerender(next);
    expect(result.current.editorData).toBeNull();
    expect(result.current.evidence).toBeNull();
    expect(result.current.editorEpoch).not.toBe(epoch);
    await waitFor(() => expect(f.read).toHaveBeenCalledTimes(3));
    const calls = f.read.mock.calls.length;
    act(() => oldReload());
    await act(async () => {
      expect((await oldRun(command())).outcome).toBe("forbidden");
    });
    expect(f.execute).not.toHaveBeenCalled();
    expect(f.read).toHaveBeenCalledTimes(calls);
    await act(async () => {
      current.resolve(details("7", "7.0000", next.query.connectionId));
    });
    await waitFor(() => expect(result.current.editorData?.revision).toBe("7"));
    await act(async () => {
      old.resolve(details("old", "999.0000"));
    });
    expect(result.current.editorData?.revision).toBe("7");
    expect(result.current.evidence?.revision).toBe("7");
  },
);

test("a delayed explicit reload cannot rebase another query or revive old callbacks on return", async () => {
  const f = fixture();
  const { result, rerender } = renderHook(useEditor, { initialProps: f.input });
  await waitFor(() => expect(result.current.canEdit).toBe(true));
  const oldReload = result.current.reload,
    oldRun = result.current.action.run;
  const old = deferred<ProviderReadResult>();
  f.read.mockReturnValueOnce(old.promise);
  act(() => result.current.reload());
  await waitFor(() => expect(f.read).toHaveBeenCalledTimes(2));
  f.read.mockResolvedValueOnce(details("7", "7.0000", "connection-b"));
  rerender({ ...f.input, query: { kind: "details", connectionId: "connection-b" } });
  await waitFor(() => expect(result.current.editorData?.revision).toBe("7"));
  await act(async () => {
    old.resolve(details("9", "9.0000"));
  });
  expect(result.current.editorData?.revision).toBe("7");
  rerender(f.input);
  await waitFor(() => expect(result.current.evidence?.revision).toBe("9"));
  const calls = f.read.mock.calls.length;
  act(() => oldReload());
  await act(async () => {
    expect((await oldRun(command())).outcome).toBe("forbidden");
  });
  expect(f.read).toHaveBeenCalledTimes(calls);
  expect(f.execute).not.toHaveBeenCalled();
});

test.each(["forbidden", "conflict"] as const)(
  "keeps an execute-%s write fence through reset and background reads until explicit reload",
  async (outcome) => {
    const f = fixture();
    f.execute.mockImplementationOnce(async (_binding, input) =>
      outcome === "forbidden"
        ? { outcome, commandId: input.commandId }
        : { outcome, commandId: input.commandId, reason: "revision", currentRevision: "2" },
    );
    const { result } = renderHook(() => useEditor(f.input));
    await waitFor(() => expect(result.current.canEdit).toBe(true));
    await act(async () => {
      await result.current.action.run(command());
    });
    await waitFor(() => expect(result.current.canEdit).toBe(false));
    if (outcome === "forbidden") expect(result.current.evidence).toBeNull();
    act(() => result.current.action.reset());
    f.read.mockResolvedValueOnce(details("2"));
    act(() => f.input.client.invalidate(f.input.port, f.input.binding));
    await waitFor(() => expect(result.current.refreshing).toBe(false));
    if (outcome === "conflict") expect(result.current.evidence?.revision).toBe("2");
    else expect(result.current.evidence).toBeNull();
    await act(async () => {
      expect((await result.current.action.run(command("another"))).outcome).toBe("forbidden");
    });
    expect(result.current.canEdit).toBe(false);
    expect(f.execute).toHaveBeenCalledTimes(1);
    f.read.mockResolvedValueOnce(details("3"));
    act(() => result.current.reload());
    await waitFor(() => expect(result.current.editorData?.revision).toBe("3"));
    expect(result.current.canEdit).toBe(true);
  },
);

test("reload and reset cannot release pending or ambiguous work, and status reads do not require financial evidence", async () => {
  const f = fixture(),
    answer = deferred<ProviderActionResult>();
  f.execute.mockReturnValueOnce(answer.promise);
  const { result } = renderHook(() => useEditor(f.input));
  await waitFor(() => expect(result.current.canEdit).toBe(true));
  const epoch = result.current.editorEpoch,
    staleReload = result.current.reload;
  let running!: Promise<ProviderActionResult>;
  act(() => {
    running = result.current.action.run(command());
  });
  await waitFor(() => expect(result.current.action.pending).toBe(true));
  act(() => {
    staleReload();
    result.current.reload();
    result.current.action.reset();
  });
  expect(f.read).toHaveBeenCalledTimes(1);
  expect(result.current.editorEpoch).toBe(epoch);
  expect(result.current.action.submittedCommand).toEqual(command());
  await act(async () => {
    answer.resolve({
      outcome: "unavailable",
      commandId: "draft",
      message: "Response lost",
      ambiguous: true,
    });
    await running;
  });
  act(() => {
    result.current.reload();
    result.current.action.reset();
  });
  expect(result.current.action.ambiguous).toBe(true);
  expect(result.current.canEdit).toBe(false);
  expect(f.read).toHaveBeenCalledTimes(1);
  f.read.mockResolvedValue({ outcome: "forbidden" });
  act(() => f.input.client.invalidate(f.input.port, f.input.binding));
  await waitFor(() => expect(result.current.evidence).toBeNull());
  expect(result.current.action.canReconcile).toBe(true);
  await act(async () => {
    expect((await result.current.action.reconcile()).outcome).toBe("success");
  });
  expect(f.reconcile).toHaveBeenCalledWith(f.input.binding, command());
  expect(result.current.action.ambiguous).toBe(false);
  expect(result.current.canEdit).toBe(false);
  expect(f.execute).toHaveBeenCalledTimes(1);
});

test("an empty current target cannot authorize writes against the retained base", async () => {
  const f = fixture();
  const { result } = renderHook(() => useEditor(f.input));
  await waitFor(() => expect(result.current.canEdit).toBe(true));
  const base = result.current.editorData;
  f.read.mockResolvedValueOnce({
    outcome: "ok",
    value: {
      kind: "details",
      state: "empty",
      problem: null,
      asOf: null,
      revision: "2",
      connection: null,
    },
  });
  act(() => f.input.client.invalidate(f.input.port, f.input.binding));
  await waitFor(() => expect(result.current.state).toBe("empty"));
  expect(result.current.editorData).toBe(base);
  expect(result.current.canEdit).toBe(false);
  await act(async () => {
    expect((await result.current.action.run(command())).outcome).toBe("forbidden");
  });
  expect(f.execute).not.toHaveBeenCalled();
});

test("uses the retained CAS revision and exact zero without treating timestamps as authorization", async () => {
  const f = fixture();
  const { result } = renderHook(() => useEditor(f.input));
  await waitFor(() => expect(result.current.canEdit).toBe(true));
  f.read.mockResolvedValueOnce(details("2", "2.0000"));
  act(() => f.input.client.invalidate(f.input.port, f.input.binding));
  await waitFor(() => expect(result.current.evidence?.revision).toBe("2"));
  expect(result.current.editorData?.revision).toBe("1");
  await act(async () => {
    expect(
      (await result.current.action.run(command("zero", result.current.editorData?.revision)))
        .outcome,
    ).toBe("success");
  });
  expect(f.execute).toHaveBeenCalledWith(f.input.binding, command("zero", "1"), undefined);
});

test("same-query remounts retain the original submitted command through pending, ambiguity and reconciliation", async () => {
  const f = fixture(),
    answer = deferred<ProviderActionResult>();
  f.execute.mockReturnValueOnce(answer.promise);
  const first = renderHook(() => useEditor(f.input));
  await waitFor(() => expect(first.result.current.canEdit).toBe(true));
  const original: ProviderCommand = {
    kind: "rates",
    commandId: "remounted",
    connectionId: "connection-a",
    expectedRevision: "1",
    rates: [{ rateId: "search", price: "9.8765" }],
  };
  let running!: Promise<ProviderActionResult>;
  act(() => {
    running = first.result.current.action.run(original);
  });
  await waitFor(() => expect(first.result.current.action.pending).toBe(true));
  first.unmount();
  const second = renderHook(() => useEditor(f.input));
  expect(second.result.current.action.pending).toBe(true);
  expect(second.result.current.action.submittedCommand).toEqual(original);
  await act(async () => {
    answer.resolve({
      outcome: "unavailable",
      commandId: original.commandId,
      ambiguous: true,
      message: "Response lost",
    });
    await running;
  });
  second.unmount();
  const third = renderHook(() => useEditor(f.input));
  expect(third.result.current.action.ambiguous).toBe(true);
  expect(third.result.current.action.submittedCommand).toEqual(original);
  act(() => {
    third.result.current.reload();
    third.result.current.action.reset();
  });
  expect(third.result.current.action.submittedCommand).toEqual(original);
  await act(async () => {
    await third.result.current.action.reconcile();
  });
  expect(f.reconcile).toHaveBeenCalledWith(f.input.binding, original);
  expect(f.execute).toHaveBeenCalledTimes(1);
});

test("another canonical query cannot rehydrate an original command for the same connection", async () => {
  const f = fixture(),
    answer = deferred<ProviderActionResult>();
  f.execute.mockReturnValueOnce(answer.promise);
  const first = renderHook(() => useEditor(f.input));
  await waitFor(() => expect(first.result.current.canEdit).toBe(true));
  let running!: Promise<ProviderActionResult>;
  act(() => {
    running = first.result.current.action.run(command("query-owned"));
  });
  first.unmount();
  f.read.mockResolvedValueOnce({
    outcome: "ok",
    value: {
      kind: "balance",
      state: "empty",
      problem: null,
      asOf: null,
      revision: "2",
      balance: null,
    },
  });
  const second = renderHook(() =>
    useProviderEditor({ kind: "balance", connectionId: "connection-a" }, f.input),
  );
  expect(second.result.current.action.pending).toBe(true);
  expect(second.result.current.action.submittedCommand).toBeNull();
  expect(second.result.current.action.result).toBeNull();
  await act(async () => {
    answer.resolve({
      outcome: "unavailable",
      commandId: "query-owned",
      ambiguous: true,
      message: "Response lost",
    });
    await running;
  });
  expect(second.result.current.action.submittedCommand).toBeNull();
  expect(second.result.current.action.canReconcile).toBe(true);
});

test.each([false, true])(
  "connections composition accepts current CAS for a refreshed target (new target: %s)",
  async (newTarget) => {
    const f = fixture();
    const snapshot = (revision: string, id = "connection-a"): ProviderReadResult => {
      const read = details(revision, "1.2345", id);
      if (read.outcome !== "ok" || read.value.kind !== "details" || !read.value.connection)
        throw new Error("Invalid test fixture");
      return {
        outcome: "ok",
        value: {
          kind: "connections",
          state: "ok",
          problem: null,
          asOf: null,
          revision,
          connections: [read.value.connection],
          providers: [],
        },
      };
    };
    f.read.mockResolvedValueOnce(snapshot("1"));
    const { result } = renderHook(() => useProviderEditor({ kind: "connections" }, f.input));
    await waitFor(() => expect(result.current.canEdit).toBe(true));
    const id = newTarget ? "connection-b" : "connection-a";
    f.read.mockResolvedValueOnce(snapshot("2", id));
    act(() => f.input.client.invalidate(f.input.port, f.input.binding));
    await waitFor(() => expect(result.current.evidence?.revision).toBe("2"));
    const input: ProviderCommand = {
      kind: "rates",
      commandId: "selected",
      connectionId: id,
      expectedRevision: "2",
      rates: [{ rateId: "search", price: "0" }],
    };
    await act(async () => {
      expect((await result.current.action.run(input)).outcome).toBe("success");
    });
    expect(f.execute).toHaveBeenCalledWith(f.input.binding, input, undefined);
    expect(result.current.editorData?.revision).toBe("1");
  },
);

test("an explicit reload rebases from a newer read that supersedes it, such as an access refresh", async () => {
  const f = fixture();
  const { result } = renderHook(() => useEditor(f.input));
  await waitFor(() => expect(result.current.canEdit).toBe(true));
  const superseded = deferred<ProviderReadResult>();
  f.read.mockReturnValueOnce(superseded.promise).mockResolvedValueOnce(details("2", "2.0000"));
  act(() => {
    result.current.reload();
    f.input.client.invalidate(f.input.port, f.input.binding);
  });
  await waitFor(() => expect(result.current.editorData?.revision).toBe("2"));
  await act(async () => {
    superseded.resolve(details("9", "9.0000"));
  });
  expect(result.current.editorData?.revision).toBe("2");
  expect(result.current.evidence?.revision).toBe("2");
});

test("a sibling command taking the journal fence consumes an in-flight reload without rebasing", async () => {
  const f = fixture(),
    read = deferred<ProviderReadResult>(),
    answer = deferred<ProviderActionResult>();
  f.execute.mockReturnValueOnce(answer.promise);
  const editor = renderHook(() => useEditor(f.input));
  const sibling = renderHook(() => useProviderAction(f.input));
  await waitFor(() => expect(editor.result.current.canEdit).toBe(true));
  const base = editor.result.current.editorData,
    epoch = editor.result.current.editorEpoch;
  f.read.mockReturnValueOnce(read.promise);
  act(() => editor.result.current.reload());
  await waitFor(() => expect(f.read).toHaveBeenCalledTimes(2));
  let running!: Promise<ProviderActionResult>;
  act(() => {
    running = sibling.result.current.run(command("sibling"));
  });
  await waitFor(() => expect(editor.result.current.action.pending).toBe(true));
  await act(async () => {
    read.resolve(details("2"));
  });
  await waitFor(() => expect(editor.result.current.refreshing).toBe(false));
  expect(editor.result.current.editorData).toBe(base);
  expect(editor.result.current.editorEpoch).toBe(epoch);
  expect(editor.result.current.canEdit).toBe(false);
  await act(async () => {
    answer.resolve({
      outcome: "unavailable",
      commandId: "sibling",
      message: "Response lost",
      ambiguous: true,
    });
    await running;
  });
  act(() => {
    editor.result.current.reload();
    editor.result.current.action.reset();
  });
  expect(editor.result.current.action.ambiguous).toBe(true);
  expect(editor.result.current.editorData).toBe(base);
  expect(editor.result.current.editorEpoch).toBe(epoch);
});

test("current details capabilities fence a withdrawn command while preserving other supported editing", async () => {
  const f = fixture();
  const { result } = renderHook(() => useEditor(f.input));
  await waitFor(() => expect(result.current.canEdit).toBe(true));
  const current = details("2");
  if (current.outcome !== "ok" || current.value.kind !== "details" || !current.value.connection)
    throw new Error("Invalid test fixture");
  current.value.connection.capabilities = ["funding"];
  f.read.mockResolvedValueOnce(current);
  act(() => f.input.client.invalidate(f.input.port, f.input.binding));
  await waitFor(() => expect(result.current.evidence?.revision).toBe("2"));
  expect(result.current.canEdit).toBe(true);
  await act(async () => {
    expect((await result.current.action.run(command("withdrawn-rate"))).outcome).toBe("forbidden");
  });
  expect(f.execute).not.toHaveBeenCalled();
  current.value.connection.capabilities = [];
  f.read.mockResolvedValueOnce(current);
  act(() => f.input.client.invalidate(f.input.port, f.input.binding));
  await waitFor(() => expect(result.current.refreshing).toBe(false));
  expect(result.current.canEdit).toBe(false);
});
