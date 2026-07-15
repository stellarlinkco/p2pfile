export {};

const STUN_PORT = Number(process.env.P2PFILE_E2E_STUN_PORT ?? 3478);
const HEALTH_PORT = Number(process.env.P2PFILE_E2E_STUN_HEALTH_PORT ?? 3479);
const MAGIC_COOKIE = 0x2112a442;

function bindingResponse(request: Uint8Array, port: number, address: string) {
  const requestView = new DataView(request.buffer, request.byteOffset, request.byteLength);
  if (
    request.byteLength < 20 ||
    requestView.getUint16(0) !== 1 ||
    requestView.getUint32(4) !== MAGIC_COOKIE
  ) {
    return null;
  }

  const octets = address.split(".").map(Number);
  if (
    octets.length !== 4 ||
    octets.some((octet) => !Number.isInteger(octet) || octet < 0 || octet > 255)
  ) {
    return null;
  }

  const response = new Uint8Array(32);
  const view = new DataView(response.buffer);
  view.setUint16(0, 0x0101);
  view.setUint16(2, 12);
  view.setUint32(4, MAGIC_COOKIE);
  response.set(request.subarray(8, 20), 8);
  view.setUint16(20, 0x0020);
  view.setUint16(22, 8);
  response[25] = 1;
  view.setUint16(26, port ^ (MAGIC_COOKIE >>> 16));
  for (let index = 0; index < octets.length; index += 1) {
    response[28 + index] = (octets[index] ?? 0) ^ response[4 + index];
  }
  return response;
}

const udp = await Bun.udpSocket({
  hostname: "127.0.0.1",
  port: STUN_PORT,
  socket: {
    data(socket, request, port, address) {
      const response = bindingResponse(request, port, address);
      if (response) socket.send(response, port, address);
    },
  },
});

const health = Bun.serve({
  hostname: "127.0.0.1",
  port: HEALTH_PORT,
  fetch: () => new Response("ok"),
});

function stop() {
  udp.close();
  void health.stop(true);
}

process.on("SIGINT", stop);
process.on("SIGTERM", stop);
