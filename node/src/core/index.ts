/**
 * The protocol core, without I/O except the chain reader: EIP-712 voucher and binding, guards
 * G1-G12, clock correction, CAIP parsing and `_meta` helpers. For tools built on the protocol
 * itself (such as `assay-mcp`); most callers use the `Assay` client instead.
 */
export * from "./binding.js";
export * from "./caip.js";
export * from "./chain.js";
export * from "./clock.js";
export * from "./errors.js";
export * from "./guard-types.js";
export * from "./guards.js";
export * from "./hex.js";
export * from "./meta.js";
export * from "./voucher.js";
export {
  guardAndBuild,
  type GuardedVoucher,
  type NetworkEntry as Eip155NetworkEntry,
} from "../schemes/eip155/index.js";
