import net from "node:net";

export interface MalwareScanner {
  scan(data: Buffer): Promise<"clean" | "infected">;
}

export class ClamAvScanner implements MalwareScanner {
  public constructor(private readonly host: string, private readonly port: number, private readonly timeoutMs = 120_000) {}

  public scan(data: Buffer): Promise<"clean" | "infected"> {
    return new Promise((resolve, reject) => {
      const socket = net.createConnection({ host: this.host, port: this.port });
      let response = "";
      const timer = setTimeout(() => { socket.destroy(); reject(new Error("ClamAV scan timed out")); }, this.timeoutMs);
      socket.on("connect", () => {
        socket.write(Buffer.from("zINSTREAM\\0"));
        const chunkSize = 64 * 1024;
        for (let offset = 0; offset < data.length; offset += chunkSize) {
          const chunk = data.subarray(offset, Math.min(offset + chunkSize, data.length));
          const length = Buffer.alloc(4); length.writeUInt32BE(chunk.length, 0); socket.write(length); socket.write(chunk);
        }
        const end = Buffer.alloc(4); socket.write(end);
      });
      socket.on("data", (chunk: Buffer) => { response += chunk.toString("utf8"); });
      socket.on("end", () => { clearTimeout(timer); if (response.includes("FOUND")) resolve("infected"); else if (response.includes("OK")) resolve("clean"); else reject(new Error(`Unexpected ClamAV response: ${response}`)); });
      socket.on("error", (error) => { clearTimeout(timer); reject(error); });
    });
  }
}
