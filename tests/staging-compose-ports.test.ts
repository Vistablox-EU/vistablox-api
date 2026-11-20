import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

const compose = readFileSync(
  fileURLToPath(new URL("../docker-compose.staging.yml", import.meta.url)),
  "utf8",
);

interface PublishedPort {
  service: string;
  entry: string;
  // Address the port is bound to on the host; undefined means every interface.
  hostIp: string | undefined;
}

// Every `ports:` list item under a service of the compose file. Short syntax
// only ("[ip:]host:container[/proto]"), which is all this file uses; the long
// syntax would be missed, so the test also refuses it.
function publishedPorts(source: string): PublishedPort[] {
  const result: PublishedPort[] = [];
  let section = "";
  let service = "";
  let inPorts = false;
  for (const raw of source.split("\n")) {
    const line = raw.replace(/\s+#.*$/, "");
    if (line.trim() === "" || line.trimStart().startsWith("#")) continue;
    const indent = (line.match(/^ */) ?? [""])[0].length;
    if (indent === 0) {
      section = line.replace(/:.*$/, "");
      inPorts = false;
      continue;
    }
    if (section !== "services") continue;
    if (indent === 2) {
      service = line.trim().replace(/:$/, "");
      inPorts = false;
    } else if (indent === 4) {
      inPorts = line.trim() === "ports:";
    } else if (inPorts && line.trim().startsWith("- ")) {
      const entry = line.trim().slice(2).trim().replace(/^["']|["']$/g, "");
      const parts = entry.replace(/\/(tcp|udp)$/, "").split(":");
      // "host:container" and "container" bind everywhere; "ip:host:container"
      // names the address. An IPv6 address would contain colons, so require
      // the bracketed form to be recognised explicitly.
      const bracketed = entry.match(/^\[([^\]]+)\]:/);
      const hostIp = bracketed ? bracketed[1] : parts.length >= 3 ? parts[0] : undefined;
      result.push({ service, entry, hostIp });
    }
  }
  return result;
}

const LOOPBACK = new Set(["127.0.0.1", "::1", "localhost"]);

// Ports that are intentionally reachable on every interface, with the reason.
// Adding a line here is a security decision: say why it cannot be loopback.
const PUBLISHED_ON_ALL_INTERFACES: Record<string, string> = {
  // Kept published for local diagnostics; Traefik serves the public API over
  // the `proxy` network (see the comment in the compose file). Moving it to
  // loopback is a separate change because TRUST_PROXY's guidance depends on it.
  "vistablox-api": "3000:3000",
};

describe("docker-compose.staging.yml published ports", () => {
  const ports = publishedPorts(compose);

  it("finds the ports it is meant to check", () => {
    const byService = Object.fromEntries(ports.map((p) => [p.service, p.entry]));
    expect(byService["maildev"]).toBeDefined();
    expect(byService["minio"]).toBeDefined();
    expect(byService["vistablox-api"]).toBeDefined();
  });

  it("does not use the long port syntax, which this check cannot read", () => {
    expect(compose).not.toMatch(/^\s+- target:\s/m);
    expect(compose).not.toMatch(/^\s+published:\s/m);
  });

  it("publishes the mail catcher UI on the loopback interface only", () => {
    const maildev = ports.filter((p) => p.service === "maildev");
    expect(maildev.map((p) => p.entry)).toEqual(["127.0.0.1:1080:1080"]);
  });

  it("publishes no port on all interfaces except the allowlisted ones", () => {
    const open = ports
      .filter((p) => p.hostIp === undefined || !LOOPBACK.has(p.hostIp))
      .map((p) => `${p.service} ${p.entry}`)
      .sort();
    const allowed = Object.entries(PUBLISHED_ON_ALL_INTERFACES)
      .map(([service, entry]) => `${service} ${entry}`)
      .sort();
    expect(open).toEqual(allowed);
  });
});
