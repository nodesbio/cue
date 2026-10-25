// Ambient declarations for untyped deps. `base-64` ships no .d.ts and has no @types package.
declare module 'base-64' {
  export function encode(input: string): string;
  export function decode(input: string): string;
}
