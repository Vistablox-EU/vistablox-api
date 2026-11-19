import { createServer, type Server, type Socket } from "node:net";
import type { AddressInfo } from "node:net";

import { afterEach, describe, expect, it, vi } from "vitest";

import { createPgPool } from "../src/infrastructure/database/pg-pool.js";

function recordingLogger() {
  return { error: vi.fn() };
}

// Nothing here connects: a pg Pool opens its first connection on the first
// query, and the tests that need a connection give it a server of their own.
const unreachable = { connectionString: "postgresql://nobody:never@127.0.0.1:1/none" };

function message(...fields: Array<[string, Buffer]>): Buffer {
  return Buffer.concat(
    fields.map(([type, body]) => {
      const header = Buffer.alloc(5);
      header.write(type, 0, "latin1");
      header.writeInt32BE(body.length + 4, 1);
      return Buffer.concat([header, body]);
    }),
  );
}

// Just enough of the PostgreSQL wire protocol for pg to treat the connection as
// open and idle: AuthenticationOk, BackendKeyData, ReadyForQuery.
function startupReply(): Buffer {
  const ok = Buffer.alloc(4);
  const key = Buffer.alloc(8);
  key.writeInt32BE(4242, 0);
  key.writeInt32BE(777_777, 4);
  return message(["R", ok], ["K", key], ["Z", Buffer.from("I")]);
}

describe("createPgPool", () => {
  const pools: Array<{ end: () => Promise<void> }> = [];
  const servers: Server[] = [];

  afterEach(async () => {
    await Promise.all(pools.splice(0).map((pool) => pool.end()));
    await Promise.all(servers.splice(0).map((server) => new Promise((resolve) => server.close(resolve))));
  });

  it("has an error listener from the moment it is created", () => {
    const pool = createPgPool(unreachable, recordingLogger(), "test");
    pools.push(pool);

    expect(pool.listenerCount("error")).toBe(1);
  });

  it("logs an error the pool emits at error level and does not throw it", () => {
    const logger = recordingLogger();
    const pool = createPgPool(unreachable, logger, "better-auth");
    pools.push(pool);
    const idleClientError = Object.assign(new Error("terminating connection due to administrator command"), {
      code: "57P01",
    });

    expect(() => pool.emit("error", idleClientError, {})).not.toThrow();

    expect(logger.error).toHaveBeenCalledTimes(1);
    const [fields, text] = logger.error.mock.calls[0] as [Record<string, unknown>, string];
    expect(text).toBe("database pool idle client error");
    expect(fields).toMatchObject({ pool: "better-auth", pg_code: "57P01" });
    expect((fields.err as Error).message).toBe("terminating connection due to administrator command");
  });

  it("does not put the dead client pg-pool attaches to the error into the log", () => {
    const logger = recordingLogger();
    const pool = createPgPool(unreachable, logger, "better-auth");
    pools.push(pool);
    // pg-pool does `err.client = client` before emitting.
    const idleClientError = Object.assign(new Error("Connection terminated unexpectedly"), {
      client: { processID: 31_337, secretKey: 987_654_321, connectionParameters: { user: "app", database: "vistablox" } },
    });

    pool.emit("error", idleClientError, idleClientError.client);

    const serialised = JSON.stringify(logger.error.mock.calls[0]?.[0], (_key, value) =>
      value instanceof Error ? { name: value.name, message: value.message, stack: value.stack } : value,
    );
    expect(serialised).not.toContain("987654321");
    expect(serialised).not.toContain("31337");
    expect(serialised).not.toContain("connectionParameters");
  });

  it("survives the database dropping an idle connection, and logs it", async () => {
    const connections: Socket[] = [];
    const server = createServer((socket) => {
      connections.push(socket);
      socket.once("data", () => socket.write(startupReply()));
      socket.on("error", () => undefined);
    });
    servers.push(server);
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const { port } = server.address() as AddressInfo;

    const uncaught: unknown[] = [];
    const onUncaught = (error: unknown) => uncaught.push(error);
    process.on("uncaughtException", onUncaught);
    try {
      const logger = recordingLogger();
      const pool = createPgPool(
        { connectionString: `postgresql://app:secret@127.0.0.1:${port}/vistablox`, max: 1 },
        logger,
        "better-auth",
      );
      pools.push(pool);

      // Check a client out and give it back: it is now an idle client in the pool.
      const client = await pool.connect();
      client.release();
      expect(connections).toHaveLength(1);

      // What a database restart does to it.
      connections[0]?.end();

      await vi.waitFor(() => expect(logger.error.mock.calls.length + uncaught.length).toBeGreaterThan(0), {
        timeout: 5_000,
      });

      // Without a listener, pg-pool's emit throws here and the process would end.
      expect(uncaught).toEqual([]);
      expect(logger.error).toHaveBeenCalledTimes(1);
      const [fields, text] = logger.error.mock.calls[0] as [Record<string, unknown>, string];
      expect(text).toBe("database pool idle client error");
      expect(fields).toMatchObject({ pool: "better-auth" });
      expect((fields.err as Error).message).toBe("Connection terminated unexpectedly");
    } finally {
      process.off("uncaughtException", onUncaught);
    }
  });
});
