/**
 * A refusal to sign. `field` names the first value that failed its check, so a caller (and a
 * test) can tell which check refused without parsing the message. The message never carries a
 * key or a signature.
 */
export class SignerRefusal extends Error {
  readonly field: string;

  constructor(what: string, field: string, reason: string) {
    super(`refusing to sign ${what}: ${field} ${reason}`);
    this.name = "SignerRefusal";
    this.field = field;
  }
}
