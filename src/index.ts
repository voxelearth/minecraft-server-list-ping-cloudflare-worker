import { Buffer } from 'node:buffer';
import { getServerStatus } from './minecraft';
import { resolveMinecraftSrv } from './srv';

const jsonResponse = (object: unknown, opts?: ResponseInit) => {
  return new Response(JSON.stringify(object, null, 2), {
    ...opts,
    headers: { 'content-type': 'application/json', ...opts?.headers },
  });
};

const offlineErrorMarkers = [
  'Network connection lost',
  'connection timed out',
  'ping timed out',
  'operation timed out',
  'connection closed before packet could be read',
];

const ensureBufferAvailable = () => {
  if (!(globalThis as any).Buffer) {
    (globalThis as any).Buffer = Buffer;
  }
};

ensureBufferAvailable();

const parsePort = (
  value: string | null
): { ok: true; value: number } | { ok: false; message: string } => {
  if (value === null || value === '') {
    return { ok: true, value: 25565 };
  }

  const parsed = Number.parseInt(value, 10);
  if (!Number.isInteger(parsed) || parsed < 1 || parsed > 65535) {
    return {
      ok: false,
      message: `'port' must be an integer between 1 and 65535`,
    };
  }

  return { ok: true, value: parsed };
};

const parseProtocol = (
  value: string | null
): { ok: true; value?: number } | { ok: false; message: string } => {
  if (!value) {
    return { ok: true };
  }

  const parsed = Number.parseInt(value, 10);
  if (!Number.isInteger(parsed) || parsed <= 0) {
    return {
      ok: false,
      message: `'protocolVersion' must be a positive integer`,
    };
  }

  return { ok: true, value: parsed };
};

const isBlank = (value: string | null) =>
  value === null || value.trim().length === 0;

export interface Env {}

export default {
  async fetch(
    request: Request,
    env: Env,
    ctx: ExecutionContext
  ): Promise<Response> {
    const { searchParams } = new URL(request.url);

    const hostname = searchParams.get('hostname');

    if (!hostname) {
      return jsonResponse(
        { ok: false, message: `'hostname' query param is required` },
        { status: 400 }
      );
    }

    const requestedPort = searchParams.get('port');
    const parsedPort = parsePort(requestedPort);
    if (!parsedPort.ok) {
      return jsonResponse(
        { ok: false, message: parsedPort.message },
        { status: 400 }
      );
    }

    const parsedProtocol = parseProtocol(searchParams.get('protocolVersion'));
    if (!parsedProtocol.ok) {
      return jsonResponse(
        { ok: false, message: parsedProtocol.message },
        { status: 400 }
      );
    }

    const shouldResolveSrv = isBlank(requestedPort);
    const srvTarget = shouldResolveSrv
      ? await resolveMinecraftSrv(hostname)
      : null;

    const targetHostname = srvTarget?.hostname ?? hostname;
    const targetPort = srvTarget?.port ?? parsedPort.value;
    const target = {
      hostname: targetHostname,
      port: targetPort,
      viaSrv: Boolean(srvTarget),
      serverAddress: hostname,
    };

    const offlineResponse = () =>
      jsonResponse(
        {
          ok: false,
          message: `'${target.hostname}:${target.port}' is unavailable`,
          data: {
            hostname,
            port: parsedPort.value,
            target,
          },
        },
        { status: 522 }
      );

    const protocolVersion = parsedProtocol.value;

    try {
      const status = await getServerStatus({
        hostname: targetHostname,
        port: targetPort,
        serverAddress: hostname,
        protocolVersion,
      });

      return jsonResponse({
        ok: true,
        target,
        status,
      });
    } catch (error: unknown) {
      const message = (error as { message?: string })?.message ?? '';
      if (offlineErrorMarkers.some((marker) => message.toLowerCase().includes(marker.toLowerCase()))) {
        return offlineResponse();
      }

      return jsonResponse(
        {
          ok: false,
          message: 'Unexpected error while retrieving status',
          data: {
            hostname,
            port: parsedPort.value,
            target,
            protocolVersion,
            internalError: {
              message,
            },
          },
        },
        {
          status: 500,
        }
      );
    }
  },
};
