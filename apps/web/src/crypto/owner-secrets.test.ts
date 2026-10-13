// @vitest-environment node
import { describe, expect, it } from "vitest";

import { encodeProfile } from "@/presence/identity";

import {
  DeviceKey,
  LinkSecret,
  PersonGraph,
  SpaceGroup,
  mergeOwnerSecrets,
  ownerPublicKeyOf,
  ownerSecretList,
  withOwnerSecrets,
} from "./wasm";

const secret = (fill: number) => new Uint8Array(32).fill(fill);

describe("owner secret helpers", () => {
  it("derive the public key of a bare secret", () => {
    expect(ownerPublicKeyOf(secret(1))).toHaveLength(32);
    expect(ownerPublicKeyOf(secret(1))).toEqual(ownerPublicKeyOf(secret(1)));
    expect(ownerPublicKeyOf(secret(1))).not.toEqual(
      ownerPublicKeyOf(secret(2)),
    );
    expect(() => ownerPublicKeyOf(new Uint8Array(31))).toThrow();
  });

  it("turn secrets into ownerSecrets bytes and back, newest first", () => {
    expect(ownerSecretList(undefined)).toEqual([]);
    expect(withOwnerSecrets(undefined, [])).toBeUndefined();
    const bytes = withOwnerSecrets(undefined, [secret(2), secret(1)])!;
    expect(ownerSecretList(bytes)).toEqual([secret(2), secret(1)]);
  });

  it("add to what is held, after it and without dropping it", () => {
    const held = withOwnerSecrets(undefined, [secret(1)]);
    const next = withOwnerSecrets(held, [secret(2), secret(1)])!;
    // Added ones only fill room, they are never newer than what is held.
    expect(ownerSecretList(next)).toEqual([secret(1), secret(2)]);
    // Already held: nothing changes.
    expect(withOwnerSecrets(next, [secret(1)])).toEqual(next);
    expect(mergeOwnerSecrets(next, held)).toEqual(next);
    expect(() => ownerSecretList(new Uint8Array([9]))).toThrow();
    // Damaged bytes have nothing to keep; a newer format is not saved over.
    expect(
      ownerSecretList(withOwnerSecrets(new Uint8Array([1]), [secret(3)])),
    ).toEqual([secret(3)]);
    expect(() => withOwnerSecrets(new Uint8Array([9]), [secret(3)])).toThrow();
    expect(() => mergeOwnerSecrets(new Uint8Array([9]), held)).toThrow();
  });

  it("never evict a held secret for added ones", () => {
    const held = withOwnerSecrets(undefined, [secret(1)]);
    const many = Array.from({ length: 20 }, (_, i) => secret(i + 2));
    const next = ownerSecretList(withOwnerSecrets(held, many));
    expect(next[0]).toEqual(secret(1));
    expect(next.length).toBeLessThan(many.length);
    expect(next.slice(1)).toEqual(many.slice(0, next.length - 1));
  });

  it("keepOwnerSecrets fills room behind what a group holds", () => {
    const create = () => {
      const seed = DeviceKey.generate().export();
      return SpaceGroup.create(
        LinkSecret.generateEdit(),
        encodeProfile({ name: "A", color: "#1d4ed8" }),
        seed,
        PersonGraph.genesis(seed).encode(),
      ).group;
    };
    const group = create();
    const own = ownerSecretList(group.ownerSecrets());
    expect(own).toHaveLength(1);
    const planted = withOwnerSecrets(
      undefined,
      Array.from({ length: 20 }, (_, i) => secret(i + 1)),
    );
    group.keepOwnerSecrets(planted);
    const after = ownerSecretList(group.ownerSecrets());
    expect(after[0]).toEqual(own[0]);
    expect(after.length).toBeGreaterThan(1);
    group.keepOwnerSecrets(undefined);
    expect(ownerSecretList(group.ownerSecrets())).toEqual(after);
    expect(() => group.keepOwnerSecrets(new Uint8Array([9]))).toThrow();
    group.free();
  });
});
