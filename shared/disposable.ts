declare global {
  interface SymbolConstructor {
    readonly dispose: unique symbol;
  }

  interface Disposable {
    [Symbol.dispose](): void;
  }
}

export {};
