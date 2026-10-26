// picomatch ships no types and @types/picomatch is not a dependency: only the call the hook makes is declared.
declare module 'picomatch' {
  function picomatch(glob: string | string[], options?: { dot?: boolean; nocase?: boolean }): (input: string) => boolean;
  export = picomatch;
}
