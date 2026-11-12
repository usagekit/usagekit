// Captured from c6865b250e01ee2e45bee01446b52f18ddd125db; see policy-free-golden.md.
export default [
  {
    outcome: "settled",
    replayed: false,
    operation: {
      operationId: "legacy-unknown",
      scope: {
        namespace: "test",
        principal: "u1",
        connection: "c1",
      },
      fundingSource: "byok",
      costOwner: "u1",
      surface: "app",
      source: "app",
      provider: "search",
      operation: "search",
      estimate: [
        {
          value: {
            $bigint: "1",
          },
          unit: "requests",
          scale: 0,
        },
      ],
      estimateSource: "manual",
      reservationExpiresAt: "2026-09-23T12:05:00.000Z",
      state: "pending",
      version: 3,
      createdAt: "2026-09-23T12:00:00.000Z",
      updatedAt: "2026-09-23T12:00:00.000Z",
      budgetEpochs: [],
      receipts: [
        {
          id: "legacy-proof",
          measurements: [
            {
              unit: "requests",
              quantity: {
                value: {
                  $bigint: "1",
                },
                unit: "requests",
                scale: 0,
              },
              certainty: "measured",
            },
          ],
          cost: {
            certainty: "unknown",
            money: null,
          },
          occurredAt: "2026-09-23T12:00:00.000Z",
          recordedAt: "2026-09-23T12:00:00.000Z",
          cached: false,
          failed: false,
        },
      ],
      lease: null,
    },
    alerts: [],
  },
  {
    outcome: "settled",
    replayed: false,
    operation: {
      operationId: "legacy-measured",
      scope: {
        namespace: "test",
        principal: "u1",
        connection: "c1",
      },
      fundingSource: "byok",
      costOwner: "u1",
      surface: "app",
      source: "app",
      provider: "search",
      operation: "search",
      estimate: [
        {
          value: {
            $bigint: "1",
          },
          unit: "requests",
          scale: 0,
        },
      ],
      estimateSource: "manual",
      reservationExpiresAt: "2026-09-23T12:05:00.000Z",
      state: "settled",
      version: 3,
      createdAt: "2026-09-23T12:00:00.000Z",
      updatedAt: "2026-09-23T12:00:00.000Z",
      budgetEpochs: [],
      receipts: [
        {
          id: "legacy-proof",
          measurements: [
            {
              unit: "requests",
              quantity: {
                value: {
                  $bigint: "1",
                },
                unit: "requests",
                scale: 0,
              },
              certainty: "measured",
            },
          ],
          cost: {
            certainty: "measured",
            money: {
              units: {
                $bigint: "1",
              },
              currency: "USD",
            },
          },
          occurredAt: "2026-09-23T12:00:00.000Z",
          recordedAt: "2026-09-23T12:00:00.000Z",
          cached: false,
          failed: false,
        },
      ],
      lease: null,
    },
    alerts: [],
  },
];
