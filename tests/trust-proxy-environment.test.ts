import express from "express";
import { describe, expect, it } from "vitest";

import { loadEnvironment } from "../src/config/environment.js";

const base = {
  DATABASE_URL: "postgresql://user:password@localhost:5432/vistablox",
  BETTER_AUTH_SECRET: "a-secure-test-secret-that-is-long-enough",
  SMTP_HOST: "smtp.example.com",
  SMTP_USER: "user",
  SMTP_PASSWORD: "password",
  SMTP_FROM: "no-reply@example.com",
  DIDIT_API_KEY: "key",
  DIDIT_WORKFLOW_ID: "269214fe-77f7-4b1a-a028-b70e861d73c1",
  DIDIT_CALLBACK_URL: "https://app.vistablox.io/kyc/complete",
  DIDIT_WEBHOOK_SECRET: "a-didit-webhook-secret-value-32-chars",
  DIDIT_APPLICATION_ID: "c2237bc6-a76c-4933-b329-6c81843b45c7",
  DIDIT_ENVIRONMENT: "sandbox",
};

describe("TRUST_PROXY environment", () => {
  it.each([undefined, ""])("trusts no proxy when unset or empty (%j)", (value) => {
    const environment = loadEnvironment(value === undefined ? base : { ...base, TRUST_PROXY: value });

    expect(environment.TRUST_PROXY).toBeUndefined();
  });

  it.each([
    ["0", 0],
    ["1", 1],
    [" 2 ", 2],
    ["10", 10],
  ])("reads %j as a hop count", (value, expected) => {
    expect(loadEnvironment({ ...base, TRUST_PROXY: value }).TRUST_PROXY).toBe(expected);
  });

  it.each([
    ["loopback", ["loopback"]],
    ["172.18.0.0/16", ["172.18.0.0/16"]],
    [" 10.0.0.1 , uniquelocal ,, fd12:3456::/32 ", ["10.0.0.1", "uniquelocal", "fd12:3456::/32"]],
    ["10.0.0.0/8", ["10.0.0.0/8"]],
    ["2001:db8::1", ["2001:db8::1"]],
    ["2001:db8::/16", ["2001:db8::/16"]],
    ["::1/128", ["::1/128"]],
    ["::1", ["::1"]],
    ["::ffff:172.18.0.2", ["::ffff:172.18.0.2"]],
  ])("reads %j as a list of proxy addresses", (value, expected) => {
    expect(loadEnvironment({ ...base, TRUST_PROXY: value }).TRUST_PROXY).toEqual(expected);
  });

  it("only returns values that Express itself accepts, so createApp cannot throw on a validated setting", () => {
    for (const value of ["loopback", "172.18.0.0/16", "10.0.0.1,uniquelocal,fd12:3456::/32", "::1", "::ffff:172.18.0.2", "2001:db8::/16"]) {
      const parsed = loadEnvironment({ ...base, TRUST_PROXY: value }).TRUST_PROXY;
      expect(() => express().set("trust proxy", parsed)).not.toThrow();
    }
  });

  it.each([
    ["true", "Express's 'true' trusts every hop, so any caller could choose its own IP"],
    ["false", "not a hop count or address list"],
    ["*", "a wildcard is not a proxy address"],
    ["11", "implausible hop count"],
    ["-1", "negative"],
    ["1.5", "not an integer"],
    ["1,2", "a hop count cannot be listed with others"],
    ["0.0.0.0/0", "a /0 range covers every peer"],
    ["::/0", "a /0 range covers every peer"],
    ["0.0.0.0/1", "half of IPv4"],
    ["128.0.0.0/1", "the other half of IPv4"],
    ["10.0.0.0/7", "IPv4 prefix below the /8 floor"],
    ["2001:db8::/15", "IPv6 prefix below the /16 floor"],
    ["::/1", "inside ::/16, which holds the IPv4-mapped addresses"],
    ["::/8", "inside ::/16, which holds the IPv4-mapped addresses"],
    ["::ffff:172.18.0.0/16", "an IPv4-mapped range is read as an IPv6 range that covers every IPv4 peer"],
    ["::ffff:0.0.0.0/96", "covers every IPv4 peer"],
    ["::ffff:172.18.0.0/112", "write IPv4 ranges as IPv4"],
    ["300.1.1.1", "not an address"],
    ["10.0.0.0/33", "prefix too long for IPv4"],
    ["fd12::/129", "prefix too long for IPv6"],
    ["10.0.0.0/", "empty prefix"],
    ["10.0.0.0/255.0.0.0", "netmask notation is not accepted"],
    ["10.0.0.0/8/8", "two prefixes"],
    ["LOOPBACK", "presets are lower-case"],
    ["::1.2.3.4", "a form Node's isIP accepts but Express's parser throws on"],
    ["2001:db8::1.2.3.4", "a form Node's isIP accepts but Express's parser throws on"],
    ["proxy.example.com", "hostnames are not accepted"],
    ["loopback,nonsense", "one bad entry rejects the list"],
  ])("rejects %j (%s)", (value) => {
    expect(() => loadEnvironment({ ...base, TRUST_PROXY: value })).toThrow(/TRUST_PROXY/);
  });
});
