import net from "node:net";
import type { AddressInfo } from "node:net";

import { afterEach, describe, expect, it } from "vitest";

import { ClamAvScanner } from "../src/infrastructure/antivirus/clamav-scanner.js";

// A stand-in for clamd's INSTREAM session, strict where clamd is strict.
//
// clamd's get_cmd (clamd/server-th.c) ends a "z"-prefixed command at the first
// NUL byte, and parse_command (clamd/session.c) answers UNKNOWN COMMAND when
// anything but the command's name sits between the "z" and that NUL. The fake
// does the same, so a scanner that puts a backslash and a "0" where the NUL
// belongs is refused here exactly as the real daemon refuses it (checked
// against clamd 1.4.6 and 1.5.4). After the command it reads the chunks
// ([4-byte big-endian length][payload]...) up to the zero-length chunk and only
// then replies, like clamd, which scans after the stream ends.

type Behaviour =
  // Send these reply bytes (in order, as separate writes) once the stream is
  // complete, then close the connection.
  | { kind: "reply"; parts: Array<string | Buffer> }
  // Accept the connection and never answer.
  | { kind: "silent" }
  // Close the connection the moment it is accepted.
  | { kind: "hang-up" };

interface Session {
  /** Every byte the client sent, in order. */
  raw: Buffer;
  /** Bytes up to and including the first NUL, or null if no NUL arrived. */
  commandLine: Buffer | null;
  /** Payload of each chunk, in order, once the command was accepted. */
  chunks: Buffer[];
  /** The 4-byte length field of each chunk, as received. */
  lengthFields: Buffer[];
  /** True once the zero-length chunk was read. */
  terminated: boolean;
  /** Bytes that arrived after the zero-length chunk. */
  trailing: Buffer;
}

const UNKNOWN_COMMAND = "UNKNOWN COMMAND\0";

class FakeClamd {
  public readonly sessions: Session[] = [];
  private readonly server: net.Server;
  private readonly sockets = new Set<net.Socket>();

  private constructor(private readonly behaviour: Behaviour) {
    this.server = net.createServer((socket) => this.accept(socket));
  }

  public static async start(behaviour: Behaviour): Promise<FakeClamd> {
    const fake = new FakeClamd(behaviour);
    await new Promise<void>((resolve) => fake.server.listen(0, "127.0.0.1", resolve));
    return fake;
  }

  public get port(): number {
    return (this.server.address() as AddressInfo).port;
  }

  public async stop(): Promise<void> {
    for (const socket of this.sockets) socket.destroy();
    await new Promise<void>((resolve) => this.server.close(() => resolve()));
  }

  private accept(socket: net.Socket): void {
    this.sockets.add(socket);
    socket.on("close", () => this.sockets.delete(socket));
    // The scanner may be torn down mid-write (timeouts, refused commands).
    socket.on("error", () => undefined);
    if (this.behaviour.kind === "hang-up") {
      socket.destroy();
      return;
    }

    const session: Session = {
      raw: Buffer.alloc(0),
      commandLine: null,
      chunks: [],
      lengthFields: [],
      terminated: false,
      trailing: Buffer.alloc(0),
    };
    this.sessions.push(session);
    let pending = Buffer.alloc(0);
    let accepted = false;
    let finished = false;

    const finish = (parts: Array<string | Buffer>): void => {
      if (finished) return;
      finished = true;
      for (const part of parts.slice(0, -1)) socket.write(part);
      const last = parts.at(-1);
      if (last === undefined) socket.end();
      else socket.end(last);
    };

    socket.on("data", (data: Buffer) => {
      session.raw = Buffer.concat([session.raw, data]);
      if (session.terminated) {
        session.trailing = Buffer.concat([session.trailing, data]);
        return;
      }
      pending = Buffer.concat([pending, data]);

      if (!accepted) {
        const nul = pending.indexOf(0);
        if (nul === -1) return;
        session.commandLine = Buffer.from(pending.subarray(0, nul + 1));
        pending = Buffer.from(pending.subarray(nul + 1));
        // 'z' selects NUL termination; what is left between it and the NUL has
        // to be exactly the command's name.
        const name = session.commandLine.subarray(1, nul).toString("latin1");
        if (session.commandLine[0] !== 0x7a || name !== "INSTREAM") {
          finish([UNKNOWN_COMMAND]);
          return;
        }
        accepted = true;
      }

      while (pending.length >= 4) {
        const length = pending.readUInt32BE(0);
        if (length === 0) {
          session.lengthFields.push(Buffer.from(pending.subarray(0, 4)));
          session.terminated = true;
          session.trailing = Buffer.from(pending.subarray(4));
          if (this.behaviour.kind === "reply") finish(this.behaviour.parts);
          return;
        }
        if (pending.length < 4 + length) return;
        session.lengthFields.push(Buffer.from(pending.subarray(0, 4)));
        session.chunks.push(Buffer.from(pending.subarray(4, 4 + length)));
        pending = Buffer.from(pending.subarray(4 + length));
      }
    });
  }
}

const fakes: FakeClamd[] = [];

async function startFake(behaviour: Behaviour): Promise<FakeClamd> {
  const fake = await FakeClamd.start(behaviour);
  fakes.push(fake);
  return fake;
}

afterEach(async () => {
  await Promise.all(fakes.splice(0).map((fake) => fake.stop()));
});

function scannerFor(fake: FakeClamd, timeoutMs?: number): ClamAvScanner {
  return timeoutMs === undefined
    ? new ClamAvScanner("127.0.0.1", fake.port)
    : new ClamAvScanner("127.0.0.1", fake.port, timeoutMs);
}

function only(fake: FakeClamd): Session {
  expect(fake.sessions).toHaveLength(1);
  return fake.sessions[0] as Session;
}

/** Deterministic, position-dependent bytes: a reordered or dropped chunk shows. */
function patterned(length: number): Buffer {
  const bytes = Buffer.alloc(length);
  for (let index = 0; index < length; index += 1) bytes[index] = (index * 31 + (index >> 8)) & 0xff;
  return bytes;
}

const KIB = 1024;
const CHUNK_LIMIT = 64 * KIB;
const OK = "stream: OK\0";
const EICAR_FOUND = "stream: Eicar-Test-Signature FOUND\0";

describe("ClamAvScanner wire format", () => {
  it("sends the literal bytes of a clamd INSTREAM session for a small buffer", async () => {
    const fake = await startFake({ kind: "reply", parts: [OK] });

    await scannerFor(fake).scan(Buffer.from("abc"));

    // zINSTREAM NUL | 00 00 00 03 "abc" | 00 00 00 00
    expect(only(fake).raw.toString("hex")).toBe("7a494e53545245414d00" + "00000003" + "616263" + "00000000");
  });

  it("starts the session with zINSTREAM and a NUL byte, not a backslash and a zero", async () => {
    const fake = await startFake({ kind: "reply", parts: [OK] });

    await scannerFor(fake).scan(Buffer.from("abc"));

    const session = only(fake);
    expect(session.commandLine).not.toBeNull();
    expect(session.commandLine?.toString("hex")).toBe("7a494e53545245414d00");
    expect(session.raw.subarray(0, 10).equals(Buffer.concat([Buffer.from("zINSTREAM", "latin1"), Buffer.from([0x00])]))).toBe(
      true,
    );
    expect(session.raw.subarray(0, 10).includes(0x5c)).toBe(false);
  });

  // One entry per boundary: empty, one byte, one chunk exactly, one byte over,
  // two chunks exactly, and the 150 KiB case (two full chunks and a remainder).
  it.each([
    { label: "an empty buffer", size: 0, expectedChunks: [] as number[] },
    { label: "one byte", size: 1, expectedChunks: [1] },
    { label: "exactly 64 KiB", size: CHUNK_LIMIT, expectedChunks: [CHUNK_LIMIT] },
    { label: "64 KiB plus one byte", size: CHUNK_LIMIT + 1, expectedChunks: [CHUNK_LIMIT, 1] },
    { label: "exactly 128 KiB", size: 2 * CHUNK_LIMIT, expectedChunks: [CHUNK_LIMIT, CHUNK_LIMIT] },
    { label: "150 KiB", size: 150 * KIB, expectedChunks: [CHUNK_LIMIT, CHUNK_LIMIT, 22 * KIB] },
  ])("frames $label as big-endian length-prefixed chunks of at most 64 KiB and a zero terminator", async ({ size, expectedChunks }) => {
    const fake = await startFake({ kind: "reply", parts: [OK] });
    const data = patterned(size);

    await expect(scannerFor(fake).scan(data)).resolves.toBe("clean");

    const session = only(fake);
    expect(session.commandLine?.toString("hex")).toBe("7a494e53545245414d00");
    expect(session.chunks.map((chunk) => chunk.length)).toEqual(expectedChunks);
    for (const chunk of session.chunks) {
      expect(chunk.length).toBeGreaterThan(0);
      expect(chunk.length).toBeLessThanOrEqual(CHUNK_LIMIT);
    }
    // Each length field is the payload length as a 4-byte big-endian integer,
    // followed by that many bytes; the last field is four zero bytes.
    expect(session.lengthFields.slice(0, -1).map((field) => field.readUInt32BE(0))).toEqual(expectedChunks);
    expect(session.lengthFields.at(-1)?.toString("hex")).toBe("00000000");
    expect(session.terminated).toBe(true);
    expect(session.trailing.length).toBe(0);
    // The reassembled stream is the input, in order.
    expect(Buffer.concat(session.chunks).equals(data)).toBe(true);
    // And the whole request is exactly command + framed chunks + terminator.
    const expected = Buffer.concat([
      Buffer.from("zINSTREAM\0", "latin1"),
      ...expectedChunks.flatMap((length, index) => {
        const field = Buffer.alloc(4);
        field.writeUInt32BE(length, 0);
        const start = expectedChunks.slice(0, index).reduce((sum, value) => sum + value, 0);
        return [field, data.subarray(start, start + length)];
      }),
      Buffer.alloc(4),
    ]);
    expect(session.raw.equals(expected)).toBe(true);
  });

  it("writes the 64 KiB chunk length as 00 01 00 00", async () => {
    const fake = await startFake({ kind: "reply", parts: [OK] });

    await scannerFor(fake).scan(patterned(CHUNK_LIMIT));

    expect(only(fake).raw.subarray(10, 14).toString("hex")).toBe("00010000");
  });

  it("is refused, as by clamd, when the command is not exactly zINSTREAM plus NUL", async () => {
    // The pre-fix command line: "zINSTREAM" + backslash + "0". The fake treats
    // it as clamd does, so this documents what the old scanner would get.
    const fake = await startFake({ kind: "reply", parts: [OK] });
    const socket = net.createConnection({ host: "127.0.0.1", port: fake.port });
    const reply = await new Promise<string>((resolve, reject) => {
      let received = "";
      socket.on("data", (chunk) => {
        received += chunk.toString("latin1");
      });
      socket.on("close", () => resolve(received));
      socket.on("error", reject);
      socket.on("connect", () => {
        socket.write(Buffer.from("zINSTREAM\\0"));
        socket.write(Buffer.from([0, 0, 0, 3]));
        socket.write(Buffer.from("abc"));
        socket.write(Buffer.alloc(4));
      });
    });

    expect(reply).toBe(UNKNOWN_COMMAND);
    expect(only(fake).chunks).toHaveLength(0);
  });
});

describe("ClamAvScanner verdicts", () => {
  it("returns clean for stream: OK", async () => {
    const fake = await startFake({ kind: "reply", parts: [OK] });

    await expect(scannerFor(fake).scan(Buffer.from("a harmless file"))).resolves.toBe("clean");
  });

  it("returns infected for a FOUND reply", async () => {
    const fake = await startFake({ kind: "reply", parts: [EICAR_FOUND] });

    await expect(scannerFor(fake).scan(Buffer.from("not really eicar"))).resolves.toBe("infected");
  });

  it("assembles a reply that arrives in several pieces", async () => {
    const fake = await startFake({ kind: "reply", parts: ["stream: Eicar-Test-", "Signature FO", "UND\0"] });

    await expect(scannerFor(fake).scan(Buffer.from("x"))).resolves.toBe("infected");
  });

  it("rejects on UNKNOWN COMMAND (newline terminated, as clamd answers a non-z command)", async () => {
    const fake = await startFake({ kind: "reply", parts: ["UNKNOWN COMMAND\n"] });

    await expect(scannerFor(fake).scan(Buffer.from("abc"))).rejects.toThrow(/Unexpected ClamAV response: UNKNOWN COMMAND/);
  });

  it("rejects on UNKNOWN COMMAND (NUL terminated, as clamd answers a z command)", async () => {
    const fake = await startFake({ kind: "reply", parts: [UNKNOWN_COMMAND] });

    await expect(scannerFor(fake).scan(Buffer.from("abc"))).rejects.toThrow(/Unexpected ClamAV response: UNKNOWN COMMAND/);
  });

  it("rejects on an ERROR reply instead of calling the file clean", async () => {
    const fake = await startFake({ kind: "reply", parts: ["INSTREAM size limit exceeded. ERROR\0"] });

    await expect(scannerFor(fake).scan(Buffer.from("abc"))).rejects.toThrow(/Unexpected ClamAV response: INSTREAM size limit exceeded/);
  });

  it("rejects on an empty reply", async () => {
    const fake = await startFake({ kind: "reply", parts: [] });

    await expect(scannerFor(fake).scan(Buffer.from("abc"))).rejects.toThrow(/Unexpected ClamAV response/);
  });

  it("rejects when the server closes the connection without a reply", async () => {
    const fake = await startFake({ kind: "hang-up" });

    // Depending on timing the scanner sees the close as an end of stream
    // ("Unexpected ClamAV response") or as a reset/broken pipe from the socket;
    // either way it must not resolve.
    await expect(scannerFor(fake).scan(Buffer.from("abc"))).rejects.toBeInstanceOf(Error);
  });

  it("rejects on the timeout when the server never answers", async () => {
    const fake = await startFake({ kind: "silent" });

    await expect(scannerFor(fake, 150).scan(Buffer.from("abc"))).rejects.toThrow("ClamAV scan timed out");
    // It did send the whole stream before giving up.
    expect(only(fake).terminated).toBe(true);
  });

  it("rejects when nothing is listening", async () => {
    const fake = await startFake({ kind: "silent" });
    const { port } = fake;
    await fake.stop();
    fakes.splice(fakes.indexOf(fake), 1);

    await expect(new ClamAvScanner("127.0.0.1", port, 1_000).scan(Buffer.from("abc"))).rejects.toBeInstanceOf(Error);
  });
});
