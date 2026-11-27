import { extractJsonObject } from './ai-schema.ts';

export type LlmTaskGroup = 'coding' | 'bank' | 'academic' | 'classroom';

export interface LlmCallOptions {
  system: string;
  user: string;
  maxTokens?: number;
  task?: LlmTaskGroup;
}

type ProviderKind = 'gemini' | 'nvidia' | 'anthropic';

function detectProvider(apiKey: string): ProviderKind {
  if (apiKey.startsWith('nvapi-')) return 'nvidia';
  if (apiKey.startsWith('sk-ant-')) return 'anthropic';
  return 'gemini';
}

function parseRetryAfterMs(res: Response): number | undefined {
  const raw = res.headers.get('retry-after');
  if (!raw) return undefined;
  const secs = Number(raw);
  if (Number.isFinite(secs) && secs > 0) {
    return Math.min(20_000, Math.ceil(secs * 1000));
  }
  return undefined;
}

async function callGeminiText(
  apiKey: string,
  model: string,
  system: string,
  user: string,
  maxTokens: number,
): Promise<{ ok: true; text: string } | { ok: false; status: number; retryAfterMs?: number }> {
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:generateContent?key=${encodeURIComponent(apiKey)}`;
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      systemInstruction: { parts: [{ text: system }] },
      contents: [{ role: 'user', parts: [{ text: user }] }],
      generationConfig: {
        responseMimeType: 'application/json',
        maxOutputTokens: maxTokens,
      },
    }),
  });
  if (!res.ok) return { ok: false, status: res.status, retryAfterMs: parseRetryAfterMs(res) };
  const body = (await res.json()) as {
    candidates?: Array<{ content?: { parts?: Array<{ text?: string }> } }>;
  };
  const text =
    body.candidates?.[0]?.content?.parts
      ?.map((p) => p.text ?? '')
      .join('\n') ?? '';
  return { ok: true, text };
}

async function callAnthropicText(
  apiKey: string,
  model: string,
  system: string,
  user: string,
  maxTokens: number,
): Promise<{ ok: true; text: string } | { ok: false; status: number; retryAfterMs?: number }> {
  const res = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-api-key': apiKey,
      'anthropic-version': '2023-06-01',
    },
    body: JSON.stringify({
      model,
      max_tokens: maxTokens,
      system,
      messages: [{ role: 'user', content: user }],
    }),
  });
  if (!res.ok) return { ok: false, status: res.status, retryAfterMs: parseRetryAfterMs(res) };
  const body = (await res.json()) as {
    content?: Array<{ type: string; text?: string }>;
  };
  const text =
    body.content
      ?.filter((c) => c.type === 'text' && typeof c.text === 'string')
      .map((c) => c.text)
      .join('\n') ?? '';
  return { ok: true, text };
}

async function callNvidiaText(
  apiKey: string,
  model: string,
  system: string,
  user: string,
  maxTokens: number,
): Promise<{ ok: true; text: string } | { ok: false; status: number; retryAfterMs?: number }> {
  try {
    const res = await fetch('https://integrate.api.nvidia.com/v1/chat/completions', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify({
        model,
        max_tokens: maxTokens,
        temperature: 0.2,
        response_format: { type: 'json_object' },
        messages: [
          { role: 'system', content: system },
          { role: 'user', content: user },
        ],
      }),
      signal: AbortSignal.timeout(45_000),
    });
    if (!res.ok) return { ok: false, status: res.status, retryAfterMs: parseRetryAfterMs(res) };
    const body = (await res.json()) as {
      choices?: Array<{ message?: { content?: string } }>;
    };
    const text = body.choices?.[0]?.message?.content ?? '';
    return { ok: true, text };
  } catch {
    return { ok: false, status: 504 };
  }
}

function resolveKeyChain(task?: LlmTaskGroup): string[] {
  const upper = task ? task.toUpperCase() : null;
  const candidates = [
    upper ? Deno.env.get(`AI_KEY_${upper}`)?.trim() : undefined,
    upper ? Deno.env.get(`AI_KEY_${upper}_BACKUP`)?.trim() : undefined,
    Deno.env.get('NVIDIA_API_KEY')?.trim(),
    Deno.env.get('NVIDIA_API_KEY_BACKUP')?.trim(),
    Deno.env.get('GEMINI_API_KEY_PRIMARY')?.trim(),
    Deno.env.get('GEMINI_API_KEY')?.trim(),
    Deno.env.get('GEMINI_API_KEY_BACKUP')?.trim(),
    Deno.env.get('ANTHROPIC_API_KEY')?.trim(),
  ];
  return candidates.filter(
    (k, idx, arr): k is string => Boolean(k) && arr.indexOf(k) === idx,
  );
}

function resolveModelsForProvider(provider: ProviderKind, task?: LlmTaskGroup): string[] {
  const upper = task ? task.toUpperCase() : null;
  const taskOverride = upper ? Deno.env.get(`AI_MODEL_${upper}`)?.trim() : undefined;
  const globalOverride = Deno.env.get('AI_MODEL')?.trim();

  if (provider === 'nvidia') {
    const base =
      task === 'coding'
        ? ['z-ai/glm-5.3-flash', 'moonshotai/kimi-k3.1-pro', 'nvidia/nemotron-3-ultra-550b-a55b', 'google/gemma-3-12b-it']
        : task === 'bank'
          ? ['z-ai/glm-5.3-flash', 'minimaxai/minimax-m3.1-flash', 'google/gemma-3-12b-it']
          : task === 'academic'
            ? ['mistralai/mistral-large-4-1t-a52b', 'google/gemma-3-12b-it', 'z-ai/glm-5.3-flash']
            : ['google/gemma-3-12b-it', 'z-ai/glm-5.3-flash'];
    return [taskOverride, globalOverride, ...base].filter(
      (m, idx, arr): m is string => Boolean(m) && arr.indexOf(m) === idx,
    );
  }

  if (provider === 'anthropic') {
    return [taskOverride ?? globalOverride ?? 'claude-sonnet-4-20250514'];
  }

  return [taskOverride, globalOverride, 'gemini-3.8-flash', 'gemini-2.5-flash'].filter(
    (m, idx, arr): m is string => Boolean(m) && arr.indexOf(m) === idx,
  );
}

export async function callLlmJson<T>(
  opts: LlmCallOptions,
  validate: (parsed: unknown) => T,
  maxAttempts = 2,
): Promise<T> {
  const keyChain = resolveKeyChain(opts.task);
  if (keyChain.length === 0) {
    throw new Error('ai_not_configured');
  }

  let lastErr: unknown = new Error('ai_failed');
  let prompt = opts.user;

  for (let keyIdx = 0; keyIdx < keyChain.length; keyIdx++) {
    const apiKey = keyChain.at(keyIdx)!;
    const provider = detectProvider(apiKey);
    const models = resolveModelsForProvider(provider, opts.task);
    const maxTokens = opts.maxTokens ?? (provider === 'anthropic' ? 2048 : 4096);
    const hasBackup = keyIdx < keyChain.length - 1;
    let modelIdx = 0;
    let transientRetries = 0;

    for (let attempt = 1; attempt <= maxAttempts; ) {
      const model = models.at(modelIdx)!;
      const out =
        provider === 'nvidia'
          ? await callNvidiaText(apiKey, model, opts.system, prompt, maxTokens)
          : provider === 'anthropic'
            ? await callAnthropicText(apiKey, model, opts.system, prompt, maxTokens)
            : await callGeminiText(apiKey, model, opts.system, prompt, maxTokens);

      if (!out.ok) {
        lastErr = new Error(`ai_http_${out.status}`);
        if ((out.status === 404 || out.status === 400) && modelIdx < models.length - 1) {
          modelIdx += 1;
          continue;
        }
        if ((out.status === 429 || out.status === 403 || out.status === 401) && hasBackup) {
          break;
        }
        const isTransient = out.status === 429 || out.status === 500 || out.status === 502 || out.status === 503 || out.status === 504;
        if (isTransient && transientRetries < (hasBackup ? 1 : 3)) {
          transientRetries += 1;
          const delayMs = out.retryAfterMs ?? Math.min(12_000, 2000 * 2 ** (transientRetries - 1));
          await new Promise((resolve) => setTimeout(resolve, delayMs));
          continue;
        }
        if (hasBackup) {
          break;
        }
        attempt += 1;
        continue;
      }

      try {
        const parsed = extractJsonObject(out.text);
        return validate(parsed);
      } catch (err) {
        lastErr = err;
        attempt += 1;
        prompt = `${opts.user}\n\nYour previous reply was not valid JSON matching the schema. Return ONLY a single valid JSON object with no markdown prose.`;
      }
    }
  }

  throw lastErr instanceof Error ? lastErr : new Error('ai_invalid_output');
}
