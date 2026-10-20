/** A package that cannot be added; the message is written for the user. */
export class PackageError extends Error {
  constructor(message: string, cause?: Error) {
    super(message, { cause });
    this.name = "PackageError";
  }
}
