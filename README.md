# Minecraft server list ping

A compact Cloudflare Worker that opens a TCP socket to any Minecraft server, performs the
[server list ping](https://wiki.vg/Server_List_Ping) exchange, and returns the JSON payload
you would normally see in the multiplayer screen.

## Quick start

1. Install dependencies: `npm install`
2. Start a local worker: `npm run dev`
3. Query the worker: `curl "http://127.0.0.1:8787/?hostname=mc.hypixel.net"`

Deploy with `wrangler deploy` once you are happy with the results.

## Ping API

Endpoint: `GET /?hostname=<host>[&port=<int>][&protocolVersion=<int>]`

| Query param       | Required | Default | Description                                                                 |
| ----------------- | -------- | ------- | --------------------------------------------------------------------------- |
| `hostname`        | Yes      | N/A     | FQDN or IP of the Minecraft server you want to ping.                        |
| `port`            | No       | `SRV -> 25565` | TCP port exposed by the server. When omitted we honor `_minecraft._tcp.<host>` if present, otherwise fall back to `25565`. Must be between 1 and 65535 when provided. |
| `protocolVersion` | No       | `765`   | Protocol number sent in the handshake. Override when targeting older builds.|

Successful responses look like:

```json
{
  "ok": true,
  "target": {
    "hostname": "mc.hypixel.net",
    "port": 25565,
    "viaSrv": false,
    "serverAddress": "mc.hypixel.net"
  },
  "status": {
    "version": { "name": "1.20.4", "protocol": 765 },
    "players": { "max": 200000, "online": 55049 },
    "description": { "text": "Hypixel Network" },
    "favicon": "data:image/png;base64,..."
  }
}
```

If the TCP handshake fails or the host is offline you will receive:

```json
{
  "ok": false,
  "message": "'mc.invalid.example:25565' is unavailable",
  "data": {
    "hostname": "mc.invalid.example",
    "port": 25565,
    "target": {
      "hostname": "mc.invalid.example",
      "port": 25565,
      "viaSrv": false,
      "serverAddress": "mc.invalid.example"
    }
  }
}
```

### SRV lookups

If you do not pass a `port`, the worker resolves `_minecraft._tcp.<hostname>` via Cloudflare's DNS-over-HTTPS endpoint. Any SRV redirect is followed (respecting priority & weight), so hosts fronted by play.domain.tld records resolve exactly like the vanilla client. When no SRV record exists, or when you explicitly specify `port`, the worker simply uses the provided/default value.

Importantly, the TCP connection is opened against the SRV target, but the handshake still carries the original hostname in its server-address field. This mirrors the Notchian client and keeps proxy-driven networks (Bungee/Velocity/etc.) routing to the correct backend.

### Timeouts

- SRV lookup: 2 s limit when querying Cloudflare's DNS-over-HTTPS endpoint. Slow/failed lookups fall back to the default port.
- Ping request: 4.5 s limit from TCP connect through status response. If exceeded, the worker closes the socket and returns a `'ping timed out'` error with HTTP 522.

## How it works

The worker mirrors the Notchian client:

1. Send a [handshake packet](https://wiki.vg/Server_List_Ping#Handshake) that describes the protocol version, hostname, and port.
2. Immediately follow with a [status request](https://wiki.vg/Server_List_Ping#Status_Request).
3. Read and parse the [status response](https://wiki.vg/Server_List_Ping#Status_Response) VarInt frame.

All VarInt work is done with [`leb`](https://www.npmjs.com/package/leb), and Cloudflare's
[`connect`](https://developers.cloudflare.com/workers/runtime-apis/tcp-sockets/) API gives us raw TCP access from the worker runtime.

Wireshark makes it easy to double-check the packets if you need to troubleshoot:

![Wireshark](docs/wireshark.jpg)

```
notchian client  10 00 f9 05 09 6c 6f 63 61 6c 68 6f 73 74 63 dd 01
worker client    10 00 fa 05 09 6c 6f 63 61 6c 68 6f 73 74 63 dd 01
```
