import { extractJsonObject } from './ai-schema.ts';

export interface LlmCallOptions {
  system: string;
  user: string;
  maxTokens?: number;
}

export async function callLlmJson<T>(
  opts: LlmCallOptions,
  validate: (parsed: unknown) => T,
  maxAttempts = 2,
): Promise<T> {
  const apiKey = Deno.env.get('ANTHROPIC_API_KEY');
  const model = Deno.env.get('AI_MODEL') ?? 'claude-sonnet-4-20250514';
  if (!apiKey) {
    throw new Error('ai_not_configured');
  }

  let lastErr: unknown = new Error('ai_failed');
  let prompt = opts.user;

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    const res = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-api-key': apiKey,
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify({
        model,
        max_tokens: opts.maxTokens ?? 2048,
        system: opts.system,
        messages: [{ role: 'user', content: prompt }],
      }),
    });

    if (!res.ok) {
      lastErr = new Error(`ai_http_${res.status}`);
      continue;
    }

    const body = (await res.json()) as {
      content?: Array<{ type: string; text?: string }>;
    };
    const text = body.content
      ?.filter((c) => c.type === 'text' && typeof c.text === 'string')
      .map((c) => c.text)
      .join('\n') ?? '';

    try {
      const parsed = extractJsonObject(text);
      return validate(parsed);
    } catch (err) {
      lastErr = err;
      prompt = `${opts.user}\n\nYour previous reply was not valid JSON matching the schema. Return ONLY a single valid JSON object with no markdown prose.`;
    }
  }

  throw lastErr instanceof Error ? lastErr : new Error('ai_invalid_output');
}
