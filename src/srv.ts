const DNS_ENDPOINT = 'https://cloudflare-dns.com/dns-query';
const SRV_PREFIX = '_minecraft._tcp.';
const SRV_RECORD_TYPE = 33;
const SRV_LOOKUP_TIMEOUT_MS = 2000;

type DnsAnswer = {
  name: string;
  type: number;
  TTL: number;
  data: string;
};

type DnsJsonResponse = {
  Status: number;
  Answer?: DnsAnswer[];
};

type ParsedSrvRecord = {
  priority: number;
  weight: number;
  port: number;
  target: string;
};

const parseSrvRecord = (answer: DnsAnswer): ParsedSrvRecord | null => {
  if (answer.type !== SRV_RECORD_TYPE) {
    return null;
  }

  const [priorityStr, weightStr, portStr, targetRaw] = answer.data
    .trim()
    .split(/\s+/);

  const priority = Number.parseInt(priorityStr, 10);
  const weight = Number.parseInt(weightStr, 10);
  const port = Number.parseInt(portStr, 10);
  const target = targetRaw?.replace(/\.$/, '');

  if (
    !Number.isInteger(priority) ||
    !Number.isInteger(weight) ||
    !Number.isInteger(port) ||
    !target
  ) {
    return null;
  }

  if (port < 1 || port > 65535) {
    return null;
  }

  return {
    priority,
    weight: Math.max(0, weight),
    port,
    target,
  };
};

const pickSrvRecord = (records: ParsedSrvRecord[]): ParsedSrvRecord | null => {
  if (!records.length) {
    return null;
  }

  const minPriority = Math.min(...records.map((record) => record.priority));
  const candidates = records.filter(
    (record) => record.priority === minPriority
  );
  const totalWeight = candidates.reduce(
    (sum, record) => sum + record.weight,
    0
  );

  if (totalWeight <= 0) {
    return candidates[0];
  }

  let roll = Math.random() * totalWeight;
  for (const record of candidates) {
    roll -= record.weight;
    if (roll <= 0) {
      return record;
    }
  }

  return candidates[candidates.length - 1];
};

const buildSrvQueryUrl = (hostname: string) => {
  const normalized = hostname.endsWith('.')
    ? hostname.slice(0, -1)
    : hostname;

  const url = new URL(DNS_ENDPOINT);
  url.searchParams.set('name', `${SRV_PREFIX}${normalized}`);
  url.searchParams.set('type', 'SRV');
  return url;
};

export type ResolvedSrvTarget = {
  hostname: string;
  port: number;
};

const fetchWithTimeout = async (
  input: string,
  init: RequestInit,
  timeoutMs: number
) => {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(input, { ...init, signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
};

export const resolveMinecraftSrv = async (
  hostname: string
): Promise<ResolvedSrvTarget | null> => {
  try {
    const url = buildSrvQueryUrl(hostname);
    const response = await fetchWithTimeout(
      url.toString(),
      {
        headers: {
          accept: 'application/dns-json',
        },
      },
      SRV_LOOKUP_TIMEOUT_MS
    );

    if (!response.ok) {
      return null;
    }

    const result = (await response.json()) as DnsJsonResponse;
    const answers = result.Answer ?? [];
    const parsed = answers
      .map(parseSrvRecord)
      .filter((record): record is ParsedSrvRecord => record !== null);

    const selection = pickSrvRecord(parsed);
    if (!selection) {
      return null;
    }

    return {
      hostname: selection.target,
      port: selection.port,
    };
  } catch {
    return null;
  }
};
