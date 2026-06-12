export function json(value: unknown, init?: ResponseInit) {
  const headers = new Headers(init?.headers);
  headers.set("content-type", "application/json; charset=utf-8");
  return new Response(JSON.stringify(value), { ...init, headers });
}

export function notFound(message = "not found") {
  return json({ message }, { status: 404 });
}

export function badRequest(message: string) {
  return json({ message }, { status: 400 });
}
