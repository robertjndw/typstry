// A project's keys for tests, made the way a creator makes them.
import { SpaceCrypto } from "./space-crypto";
import { DocKeys, Keyring, LinkSecret } from "./wasm";

export interface TestProject {
  link: LinkSecret;
  keyring: Keyring;
  /** The keyring as the server stores it. */
  signed: Uint8Array;
  /** The creator's device. */
  crypto: SpaceCrypto;
}

export function newProject(): TestProject {
  const link = LinkSecret.generateEdit();
  const keyring = Keyring.generate(link);
  return {
    link,
    keyring,
    signed: keyring.sealSigned(link),
    crypto: new SpaceCrypto(link, new DocKeys(keyring)),
  };
}

/** Another device opening the project from the edit link. */
export function editorOf(project: TestProject): SpaceCrypto {
  return SpaceCrypto.open(project.link.toBase64url(), project.signed);
}

/** Someone holding only the view link. */
export function viewerOf(project: TestProject): SpaceCrypto {
  return SpaceCrypto.open(project.link.viewSecret(), project.signed);
}
