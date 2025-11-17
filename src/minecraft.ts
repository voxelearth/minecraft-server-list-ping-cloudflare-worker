import { connect } from 'cloudflare:sockets';
import leb from 'leb';
import { Buffer } from 'node:buffer';

const DEFAULT_PROTOCOL_VERSION = 765; // Minecraft 1.20.4
const NEXT_STATE_STATUS = 1;
const PACKET_HANDSHAKE = 0x00;
const PACKET_STATUS_REQUEST = 0x00;
const PACKET_STATUS_RESPONSE = 0x00;
const PING_TIMEOUT_MS = 4500;

type ChatComponent = {
  text?: string;
  extra?: ChatComponent[];
  color?: string;
  bold?: boolean;
  italic?: boolean;
  [key: string]: unknown;
};

export type StatusResponse = {
  version: {
    name: string;
    protocol: number;
  };
  players: {
    max: number;
    online: number;
    sample?: Array<{ name: string; id: string }>;
  };
  description: string | ChatComponent;
  favicon?: string;
  enforcesSecureChat?: boolean;
  previewsChat?: boolean;
};

type PingOptions = {
  hostname: string;
  port: number;
  serverAddress: string;
  protocolVersion?: number;
  timeoutMs?: number;
};

const releaseLock = (lock: { releaseLock: () => void }) => {
  try {
    lock.releaseLock();
  } catch {}
};

const withTimeout = <T>(
  promise: Promise<T>,
  timeoutMs: number,
  onTimeout: () => void
): Promise<T> =>
  new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      onTimeout();
      reject(new Error('ping timed out'));
    }, timeoutMs);

    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (error) => {
        clearTimeout(timer);
        reject(error);
      }
    );
  });

const encodeVarInt = (value: number) => Buffer.from(leb.encodeInt32(value));

const encodeString = (value: string) => {
  const encoded = Buffer.from(value, 'utf8');
  return Buffer.concat([encodeVarInt(encoded.length), encoded]);
};

const buildPacket = (packetId: number, payload?: Buffer) => {
  const packetIdBytes = encodeVarInt(packetId);
  const body = payload ? Buffer.concat([packetIdBytes, payload]) : packetIdBytes;
  return Buffer.concat([encodeVarInt(body.length), body]);
};

const buildHandshakePacket = (
  serverAddress: string,
  port: number,
  protocolVersion: number
) => {
  const portBuffer = Buffer.allocUnsafe(2);
  portBuffer.writeUInt16BE(port, 0);
  const payload = Buffer.concat([
    encodeVarInt(protocolVersion),
    encodeString(serverAddress),
    portBuffer,
    encodeVarInt(NEXT_STATE_STATUS),
  ]);
  return buildPacket(PACKET_HANDSHAKE, payload);
};

const buildStatusRequestPacket = () => buildPacket(PACKET_STATUS_REQUEST);

const readPacket = async (
  reader: ReadableStreamDefaultReader<Uint8Array>
): Promise<Buffer> => {
  let buffer = Buffer.alloc(0);

  while (true) {
    const { value, done } = await reader.read();
    if (done) {
      break;
    }
    if (!value) {
      continue;
    }

    const chunk = Buffer.from(value);
    buffer = buffer.length ? Buffer.concat([buffer, chunk]) : chunk;

    let packetLength: number | undefined;
    let headerSize: number | undefined;
    try {
      const decoded = leb.decodeInt32(buffer, 0);
      packetLength = decoded.value;
      headerSize = decoded.nextIndex;
    } catch {
      continue;
    }

    if (packetLength === undefined || headerSize === undefined) {
      continue;
    }

    const total = headerSize + packetLength;
    if (buffer.length >= total) {
      return buffer.subarray(0, total);
    }
  }

  throw new Error('connection closed before packet could be read');
};

const parseStatusPacket = (packet: Buffer): StatusResponse => {
  const packetLength = leb.decodeInt32(packet, 0);
  const packetType = leb.decodeInt32(packet, packetLength.nextIndex);

  if (packetType.value !== PACKET_STATUS_RESPONSE) {
    throw new Error(`unexpected packet id ${packetType.value}`);
  }

  const jsonLength = leb.decodeInt32(packet, packetType.nextIndex);
  const start = jsonLength.nextIndex;
  const end = start + jsonLength.value;

  if (end > packet.length) {
    throw new Error('status payload truncated');
  }

  const payload = packet.subarray(start, end).toString('utf8');
  return JSON.parse(payload);
};

export const getServerStatus = async ({
  hostname,
  port,
  serverAddress,
  protocolVersion = DEFAULT_PROTOCOL_VERSION,
  timeoutMs = PING_TIMEOUT_MS,
}: PingOptions): Promise<StatusResponse> => {
  const socket = connect({ hostname, port });
  const writer = socket.writable.getWriter();
  const reader = socket.readable.getReader();

  const pingPromise = (async () => {
    try {
      await writer.write(
        buildHandshakePacket(serverAddress, port, protocolVersion)
      );
      await writer.write(buildStatusRequestPacket());
      const packet = await readPacket(reader);
      return parseStatusPacket(packet);
    } finally {
      releaseLock(writer);
      releaseLock(reader);
      socket.close();
    }
  })();

  return withTimeout(pingPromise, timeoutMs, () => {
    socket.close();
  });
};
