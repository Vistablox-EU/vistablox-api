import net from "node:net";
import { afterEach, describe, expect, it } from "vitest";
import { ClamAvScanner } from "../src/infrastructure/antivirus/clamav-scanner.js";

const servers: net.Server[] = [];

afterEach(() => {
  for (const server of servers.splice(0)) server.close();
});

async function fakeClamd(reply: string): Promise<{ port: number; received: () => Buffer }> {
  const chunks: Buffer[] = [];
  const server = net.createServer((socket) => {
    socket.on("data", (chunk) => {
      chunks.push(chunk);
      const all = Buffer.concat(chunks);
      if (all.subarray(-4).equals(Buffer.alloc(4))) socket.end(reply);
    });
  });
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  return { port: (server.address() as net.AddressInfo).port, received: () => Buffer.concat(chunks) };
}

describe("ClamAvScanner wire format", () => {
  it("sends zINSTREAM followed by a real NUL byte, then length-prefixed chunks and a zero terminator", async () => {
    const fake = await fakeClamd("stream: OK\0");
    const result = await new ClamAvScanner("127.0.0.1", fake.port).scan(Buffer.from("hello"));
    expect(result).toBe("clean");

    const expected = Buffer.concat([
      Buffer.from([0x7a, 0x49, 0x4e, 0x53, 0x54, 0x52, 0x45, 0x41, 0x4d, 0x00]),
      Buffer.from([0, 0, 0, 5]),
      Buffer.from("hello"),
      Buffer.alloc(4),
    ]);
    expect(fake.received().equals(expected)).toBe(true);
  });

  it("reports infected when the daemon answers FOUND", async () => {
    const fake = await fakeClamd("stream: Eicar-Test-Signature FOUND\0");
    await expect(new ClamAvScanner("127.0.0.1", fake.port).scan(Buffer.from("x"))).resolves.toBe("infected");
  });
});
