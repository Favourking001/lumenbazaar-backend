import type { PrismaClient } from "@prisma/client";
import { describe, expect, it } from "vitest";

import { PrismaResourceStore } from "./catalogPersistence.js";

/**
 * Unit-level concurrency coverage for the Prisma store's conditional update
 * (issue #102). No live Postgres is needed: the fake client below implements
 * the same compare-and-swap contract as `updateMany({ where: { id, version },
 * data: { ..., version: { increment: 1 } } })` — it only applies the write
 * when the stored version still matches — so a race between two writers
 * with the same expected version has exactly one winner, exactly as the
 * database enforces it. The full-stack version of this test lives in
 * catalogPersistence.integration.test.ts and runs against real Postgres.
 */

type FakeResourceRow = {
  id: string;
  sellerId: string;
  type: string;
  name: string;
  description: string;
  url: string;
  routeTemplate: string;
  network: string;
  payTo: string;
  assetCode: string;
  assetIssuer: string;
  amount: string;
  inputSchema: Record<string, unknown>;
  outputSchema: Record<string, unknown>;
  extensions: Record<string, unknown>;
  status: string;
  version: number;
  createdAt: Date;
  updatedAt: Date;
};

function createFakeDb(seed: FakeResourceRow) {
  const rows = new Map<string, FakeResourceRow>([[seed.id, { ...seed }]]);
  const versionRows: Array<{ resourceId: string; version: number; metadata: unknown }> = [
    { resourceId: seed.id, version: 1, metadata: {} }
  ];
  const tx = {
    resource: {
      findUnique: async ({ where }: { where: { id: string } }) => rows.get(where.id) ?? null,
      findUniqueOrThrow: async ({ where }: { where: { id: string } }) => {
        const row = rows.get(where.id);
        if (row === undefined) throw new Error("Resource was not found.");
        return row;
      },
      updateMany: async ({
        where,
        data
      }: {
        where: { id: string; version: number };
        data: Record<string, unknown>;
      }) => {
        const row = rows.get(where.id);
        // The atomic compare-and-swap: match only on the expected version.
        if (row === undefined || row.version !== where.version) return { count: 0 };
        for (const [key, value] of Object.entries(data)) {
          if (key === "version" && typeof value === "object" && value !== null) {
            row.version += (value as { increment: number }).increment;
          } else {
            (row as Record<string, unknown>)[key] = value;
          }
        }
        row.updatedAt = new Date();
        return { count: 1 };
      }
    },
    resourceVersion: {
      create: async ({ data }: { data: { resourceId: string; version: number } }) => {
        const record = { ...data, id: `rv_${data.version}`, createdAt: new Date() };
        versionRows.push({ resourceId: data.resourceId, version: data.version, metadata: {} });
        return record;
      }
    },
    resourceSchema: {
      create: async () => ({ id: "rs_1", createdAt: new Date() })
    },
    paymentRequirement: {
      create: async () => ({ id: "pr_1", createdAt: new Date() })
    },
    searchDocument: {
      updateMany: async () => ({ count: 0 })
    }
  };
  const db = {
    $transaction: async <T>(callback: (client: typeof tx) => Promise<T>): Promise<T> => callback(tx)
  };
  return { db: db as unknown as PrismaClient, rows, versionRows };
}

function seedRow(version = 1): FakeResourceRow {
  return {
    id: "resource_1",
    sellerId: "seller_1",
    type: "http",
    name: "Paid Weather API",
    description: "Returns current weather for a city.",
    url: "https://seller.example/weather/Lagos",
    routeTemplate: "/weather/{city}",
    network: "stellar:testnet",
    payTo: "GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAWHF",
    assetCode: "USDC",
    assetIssuer: "GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAWHF",
    amount: "0.05",
    inputSchema: { type: "object" },
    outputSchema: { type: "object" },
    extensions: {},
    status: "active",
    version,
    createdAt: new Date(),
    updatedAt: new Date()
  };
}

describe("PrismaResourceStore optimistic concurrency", () => {
  it("lets exactly one of two concurrent writers win; the loser gets a typed conflict", async () => {
    const { db, rows, versionRows } = createFakeDb(seedRow(1));
    const store = new PrismaResourceStore(db);

    const attempts = await Promise.allSettled([
      store.updateResource("resource_1", { name: "writer A" }, { expectedVersion: 1 }),
      store.updateResource("resource_1", { name: "writer B" }, { expectedVersion: 1 })
    ]);
    const fulfilled = attempts.filter((attempt) => attempt.status === "fulfilled");
    const rejected = attempts.filter((attempt) => attempt.status === "rejected");

    expect(fulfilled).toHaveLength(1);
    expect(rejected).toHaveLength(1);
    const conflict = (rejected[0] as PromiseRejectedResult).reason as {
      code?: string;
      statusCode?: number;
      details?: Record<string, unknown>;
    };
    expect(conflict.code).toBe("RESOURCE_VERSION_CONFLICT");
    expect(conflict.statusCode).toBe(409);
    expect(conflict.details).toMatchObject({ expectedVersion: 1, currentVersion: 2 });

    // No lost update: the stored row is exactly the winner's, at version 2.
    const winner = (fulfilled[0] as PromiseFulfilledResult<{ name: string }>).value;
    expect(rows.get("resource_1")!.version).toBe(2);
    expect(rows.get("resource_1")!.name).toBe(winner.name);
    expect(versionRows.map((entry) => entry.version)).toEqual([1, 2]);
  });

  it("rejects a stale write with a typed conflict and leaves the row untouched", async () => {
    const { db, rows } = createFakeDb(seedRow(2));
    const store = new PrismaResourceStore(db);

    await expect(
      store.updateResource("resource_1", { name: "stale write" }, { expectedVersion: 1 })
    ).rejects.toMatchObject({
      code: "RESOURCE_VERSION_CONFLICT",
      statusCode: 409,
      details: { expectedVersion: 1, currentVersion: 2 }
    });
    expect(rows.get("resource_1")!.name).toBe("Paid Weather API");
    expect(rows.get("resource_1")!.version).toBe(2);
  });

  it("rejects a mutation with no version precondition", async () => {
    const { db } = createFakeDb(seedRow(1));
    const store = new PrismaResourceStore(db);

    await expect(
      store.updateResource(
        "resource_1",
        { name: "no precondition" },
        // @ts-expect-error deliberate: missing expectedVersion
        {}
      )
    ).rejects.toMatchObject({ code: "VALIDATION_FAILED" });
  });

  it("guards rollback with the same precondition and increments the version", async () => {
    const { db, rows, versionRows } = createFakeDb(seedRow(2));
    const store = new PrismaResourceStore(db);

    await expect(
      store.rollbackResource("resource_1", { name: "v1" }, {}, { expectedVersion: 1 })
    ).rejects.toMatchObject({ code: "RESOURCE_VERSION_CONFLICT" });

    const rolledBack = await store.rollbackResource(
      "resource_1",
      { name: "v1" },
      { rolledBackFromVersion: 1 },
      { expectedVersion: 2 }
    );
    expect(rolledBack.resource.version).toBe(3);
    expect(rolledBack.version.version).toBe(3);
    expect(rows.get("resource_1")!.version).toBe(3);
    expect(versionRows.map((entry) => entry.version)).toEqual([1, 3]);
  });
});
