import { extractJsonObject } from './ai-schema.ts';

export interface LlmCallOptions {
  system: string;
  user: string;
  maxTokens?: number;
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

export async function callLlmJson<T>(
  opts: LlmCallOptions,
  validate: (parsed: unknown) => T,
  maxAttempts = 2,
): Promise<T> {
  const primaryGemini = Deno.env.get('GEMINI_API_KEY_PRIMARY')?.trim();
  const defaultGemini = Deno.env.get('GEMINI_API_KEY')?.trim();
  const explicitBackup = Deno.env.get('GEMINI_API_KEY_BACKUP')?.trim();
  const geminiKeys = [primaryGemini, defaultGemini, explicitBackup].filter(
    (k, idx, arr): k is string => Boolean(k) && arr.indexOf(k) === idx,
  );
  const anthropicKey = Deno.env.get('ANTHROPIC_API_KEY')?.trim();
  if (geminiKeys.length === 0 && !anthropicKey) {
    throw new Error('ai_not_configured');
  }

  const useGemini = geminiKeys.length > 0;
  const configuredModel = Deno.env.get('AI_MODEL')?.trim();
  const geminiModels = configuredModel
    ? [configuredModel]
    : ['gemini-3.8-flash', 'gemini-2.5-flash'];
  const anthropicModel = configuredModel ?? 'claude-sonnet-4-20250514';
  const maxTokens = opts.maxTokens ?? (useGemini ? 4096 : 2048);

  let lastErr: unknown = new Error('ai_failed');
  let prompt = opts.user;

  if (!useGemini) {
    let transientRetries = 0;
    for (let attempt = 1; attempt <= maxAttempts; ) {
      const out = await callAnthropicText(anthropicKey!, anthropicModel, opts.system, prompt, maxTokens);
      if (!out.ok) {
        lastErr = new Error(`ai_http_${out.status}`);
        const isTransient = out.status === 429 || out.status === 500 || out.status === 502 || out.status === 503 || out.status === 504;
        if (isTransient && transientRetries < 3) {
          transientRetries += 1;
          const delayMs = out.retryAfterMs ?? Math.min(12_000, 2000 * 2 ** (transientRetries - 1));
          await new Promise((resolve) => setTimeout(resolve, delayMs));
          continue;
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
    throw lastErr instanceof Error ? lastErr : new Error('ai_invalid_output');
  }

  for (let keyIdx = 0; keyIdx < geminiKeys.length; keyIdx++) {
    const apiKey = geminiKeys.at(keyIdx)!;
    const hasBackup = keyIdx < geminiKeys.length - 1;
    let modelIdx = 0;
    let transientRetries = 0;

    for (let attempt = 1; attempt <= maxAttempts; ) {
      const model = geminiModels.at(modelIdx)!;
      const out = await callGeminiText(apiKey, model, opts.system, prompt, maxTokens);

      if (!out.ok) {
        lastErr = new Error(`ai_http_${out.status}`);
        if (out.status === 404 && modelIdx < geminiModels.length - 1) {
          modelIdx += 1;
          continue;
        }
        // Fail over immediately to backup key on quota/auth errors when a backup key exists
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
