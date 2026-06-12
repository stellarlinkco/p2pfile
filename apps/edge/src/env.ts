type AssetFetcher = {
  fetch(request: Request): Response | Promise<Response>;
};

export type EdgeEnv = {
  ASSETS: AssetFetcher;
  SESSION_OBJECT: DurableObjectNamespace;
  SESSION_DIRECTORY: DurableObjectNamespace;
};
