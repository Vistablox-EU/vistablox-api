import net from "node:net";

import nodemailer from "nodemailer";
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  SMTP_CONNECTION_TIMEOUT_MS,
  SMTP_GREETING_TIMEOUT_MS,
  SMTP_SOCKET_TIMEOUT_MS,
  SmtpEmailSender,
  type SmtpEmailSenderOptions,
} from "../src/infrastructure/email/smtp-email-sender.js";

// A hung or dead SMTP server must cost a bounded wait, not nodemailer's own
// defaults (2 minutes to connect, 10 of silence on the socket). The servers
// below are real TCP listeners on the loopback interface speaking just enough
// SMTP to reach the step under test, so the timers that fire are nodemailer's
// own, driven by the options the sender hands it.

const RECIPIENT = "investor@example.test";
const SOON = 150;

interface FakeServer {
  port: number;
  close(): Promise<void>;
}

const running: FakeServer[] = [];

async function startServer(onConnection: (socket: net.Socket) => void): Promise<FakeServer> {
  const sockets = new Set<net.Socket>();
  const server = net.createServer((socket) => {
    sockets.add(socket);
    socket.on("close", () => sockets.delete(socket));
    socket.on("error", () => undefined);
    onConnection(socket);
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const fake: FakeServer = {
    port: (server.address() as net.AddressInfo).port,
    close: async () => {
      for (const socket of sockets) socket.destroy();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
  running.push(fake);
  return fake;
}

function lineReader(socket: net.Socket, onLine: (line: string) => void): void {
  let buffered = "";
  socket.on("data", (chunk) => {
    buffered += chunk.toString("utf8");
    let newline = buffered.indexOf("\r\n");
    while (newline !== -1) {
      onLine(buffered.slice(0, newline));
      buffered = buffered.slice(newline + 2);
      newline = buffered.indexOf("\r\n");
    }
  });
}

function senderFor(port: number, overrides: Partial<SmtpEmailSenderOptions> = {}): SmtpEmailSender {
  return new SmtpEmailSender({
    host: "127.0.0.1",
    port,
    secure: false,
    user: "user",
    password: "test-password",
    from: "VistaBlox <no-reply@example.test>",
    ...overrides,
  });
}

function sendCode(sender: SmtpEmailSender): Promise<void> {
  return sender.sendDeviceReplacementCodeEmail({ to: RECIPIENT, code: "482913", expiresInMinutes: 10 });
}

afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(running.splice(0).map((server) => server.close()));
});

describe("SmtpEmailSender timeouts", () => {
  it("builds the transport with explicit connection, greeting and socket timeouts", () => {
    const createTransport = vi.spyOn(nodemailer, "createTransport");

    senderFor(2525);

    expect(SMTP_CONNECTION_TIMEOUT_MS).toBe(10_000);
    expect(SMTP_GREETING_TIMEOUT_MS).toBe(10_000);
    expect(SMTP_SOCKET_TIMEOUT_MS).toBe(30_000);
    expect(createTransport).toHaveBeenCalledWith(
      expect.objectContaining({ connectionTimeout: 10_000, greetingTimeout: 10_000, socketTimeout: 30_000 }),
    );
  });

  it("takes overrides for tests, one timeout at a time", () => {
    const createTransport = vi.spyOn(nodemailer, "createTransport");

    senderFor(2525, { timeouts: { greetingMs: 250 } });

    expect(createTransport).toHaveBeenCalledWith(
      expect.objectContaining({ connectionTimeout: 10_000, greetingTimeout: 250, socketTimeout: 30_000 }),
    );
  });

  it.each([0, -5, 1.5, Number.NaN, Number.POSITIVE_INFINITY])(
    "refuses %s as a timeout, because nodemailer would read 0 as its own long default",
    (value) => {
      expect(() => senderFor(2525, { timeouts: { socketMs: value } })).toThrow(RangeError);
      expect(() => senderFor(2525, { timeouts: { connectionMs: value } })).toThrow(RangeError);
      expect(() => senderFor(2525, { timeouts: { greetingMs: value } })).toThrow(RangeError);
    },
  );

  it("gives up on a server that accepts the connection and never sends the greeting", async () => {
    const hung = await startServer(() => undefined);
    const started = Date.now();

    const failure = await sendCode(senderFor(hung.port, { timeouts: { greetingMs: SOON } })).then(
      () => null,
      (error: unknown) => error as Error & { code?: string },
    );

    expect(failure).not.toBeNull();
    expect(failure?.code).toBe("ETIMEDOUT");
    expect(failure?.message).toMatch(/Greeting never received/);
    expect(Date.now() - started).toBeLessThan(4_000);
  }, 15_000);

  it("gives up on a server that greets and then goes silent mid-session", async () => {
    const stalled = await startServer((socket) => {
      socket.write("220 fake ESMTP ready\r\n");
      lineReader(socket, (line) => {
        // Answer the hello, advertising AUTH so the client carries on to it,
        // then say nothing to the AUTH command itself.
        if (/^EHLO/i.test(line)) socket.write("250-fake\r\n250 AUTH PLAIN\r\n");
      });
    });
    const started = Date.now();

    const failure = await sendCode(
      senderFor(stalled.port, { timeouts: { socketMs: SOON, greetingMs: 5_000, connectionMs: 5_000 } }),
    ).then(
      () => null,
      (error: unknown) => error as Error & { code?: string },
    );

    expect(failure).not.toBeNull();
    expect(failure?.code).toBe("ETIMEDOUT");
    expect(failure?.message).toMatch(/Timeout/);
    expect(Date.now() - started).toBeLessThan(4_000);
  }, 15_000);

  it("still delivers through a server that answers promptly, under the same short timeouts", async () => {
    const received: string[] = [];
    const healthy = await startServer((socket) => {
      socket.write("220 fake ESMTP ready\r\n");
      let inData = false;
      lineReader(socket, (line) => {
        if (inData) {
          if (line === ".") {
            inData = false;
            socket.write("250 2.0.0 queued\r\n");
          } else {
            received.push(line);
          }
          return;
        }
        if (/^EHLO/i.test(line)) socket.write("250-fake\r\n250 AUTH PLAIN\r\n");
        else if (/^AUTH/i.test(line)) socket.write("235 2.7.0 ok\r\n");
        else if (/^(MAIL|RCPT)/i.test(line)) socket.write("250 ok\r\n");
        else if (/^DATA/i.test(line)) {
          inData = true;
          socket.write("354 go ahead\r\n");
        } else if (/^QUIT/i.test(line)) socket.end("221 bye\r\n");
      });
    });

    await sendCode(senderFor(healthy.port, { timeouts: { socketMs: 2_000, greetingMs: 2_000, connectionMs: 2_000 } }));

    expect(received.join("\n")).toContain("482913");
  }, 15_000);
});
