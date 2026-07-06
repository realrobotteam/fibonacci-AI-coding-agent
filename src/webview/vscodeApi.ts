// Singleton wrapper around VS Code's webview API.
//
// `acquireVsCodeApi()` can only be called ONCE per webview document — calling
// it again throws "An instance of the VS Code API has already been acquired".
// All components therefore import this shared singleton instead of calling
// `acquireVsCodeApi()` directly.

declare const acquireVsCodeApi: () => {
  postMessage(msg: unknown): void;
  getState(): unknown;
  setState(state: unknown): void;
};

type VsCodeApi = {
  postMessage(msg: unknown): void;
  getState(): unknown;
  setState(state: unknown): void;
};

let cached: VsCodeApi | null = null;

export function getVsCodeApi(): VsCodeApi {
  if (cached) return cached;
  cached = acquireVsCodeApi();
  return cached;
}

export function postMessage(msg: unknown): void {
  getVsCodeApi().postMessage(msg);
}
