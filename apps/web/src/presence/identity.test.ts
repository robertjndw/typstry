import {
  initials,
  isValidColor,
  loadIdentity,
  PALETTE,
  parseIdentity,
  randomIdentity,
  saveIdentity,
} from "./identity";

function memoryStorage(): Storage {
  const data = new Map<string, string>();
  return {
    get length() {
      return data.size;
    },
    clear: () => data.clear(),
    getItem: (k) => data.get(k) ?? null,
    key: (i) => [...data.keys()][i] ?? null,
    removeItem: (k) => void data.delete(k),
    setItem: (k, v) => void data.set(k, String(v)),
  };
}

describe("identity", () => {
  it("round-trips through storage", () => {
    const storage = memoryStorage();
    expect(loadIdentity(storage)).toBeNull();
    saveIdentity({ name: "Ada", color: PALETTE[2] }, storage);
    expect(loadIdentity(storage)).toEqual({ name: "Ada", color: PALETTE[2] });
  });

  it("rejects malformed or unsafe stored values", () => {
    const storage = memoryStorage();
    storage.setItem("typstry:identity", "{not json");
    expect(loadIdentity(storage)).toBeNull();
    storage.setItem(
      "typstry:identity",
      JSON.stringify({ name: "x", color: "red; background:url(x)" }),
    );
    expect(loadIdentity(storage)).toBeNull();
    storage.setItem(
      "typstry:identity",
      JSON.stringify({ name: "   ", color: PALETTE[0] }),
    );
    expect(loadIdentity(storage)).toBeNull();
  });

  it("survives storage that throws", () => {
    const broken = {
      getItem: () => {
        throw new Error("denied");
      },
      setItem: () => {
        throw new Error("quota");
      },
    } as unknown as Storage;
    expect(loadIdentity(broken)).toBeNull();
    expect(() =>
      saveIdentity({ name: "A", color: PALETTE[0] }, broken),
    ).not.toThrow();
    expect(loadIdentity(null)).toBeNull();
  });

  it("generates friendly names with palette colors", () => {
    let i = 0;
    const seq = [0, 0.5, 0.99];
    const identity = randomIdentity(() => seq[i++ % seq.length]!);
    expect(identity.name).toMatch(/^[A-Z][a-z]+ [A-Z][a-z]+$/);
    expect(PALETTE).toContain(identity.color);
    expect(isValidColor(identity.color)).toBe(true);
  });

  it("normalizes names and derives initials", () => {
    expect(
      parseIdentity({ name: "  Ada   Lovelace ", color: "#AABBCC" }),
    ).toEqual({ name: "Ada Lovelace", color: "#AABBCC" });
    expect(
      parseIdentity({ name: "x".repeat(100), color: PALETTE[0] })?.name,
    ).toHaveLength(40);
    expect(initials("Ada Lovelace")).toBe("AL");
    expect(initials("ada")).toBe("AD");
    expect(initials("Brave Swift Otter")).toBe("BO");
  });
});
