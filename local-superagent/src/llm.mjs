import { truncate } from './log.mjs';

export class LLMError extends Error {
  constructor(message, opts) {
    super(message);
    this.name = 'LLMError';
    this.status = (opts || {}).status || 0;
    this.retryable = Boolean((opts || {}).retryable);
    this.body = (opts || {}).body || '';
  }
}

/**
 * OpenAI-compatible chat client with an automatic offline fallback.
 *
 *   OPENAI_BASE_URL  default https://api.openai.com/v1
 *   OPENAI_API_KEY   when absent the client runs in `mock` mode and every call is
 *                    answered by the caller-supplied deterministic `mock` handler,
 *                    so the whole system is runnable and testable with zero keys.
 *
 * Any OpenAI-compatible gateway works (DeepSeek, vLLM, Ollama, LiteLLM, ...).
 */
export class LLMClient {
  constructor(opts) {
    const o = opts || {};
    this.cfg = o.cfg;
    this.logger = o.logger;
    this.fetchImpl = o.fetchImpl || globalThis.fetch;
    this.clock = o.clock || (() => Date.now());
    this.calls = 0;
    this.errors = 0;
    this.mockCalls = 0;
    this.lastError = null;
  }

  get mode() {
    return this.cfg.apiKey ? 'openai' : 'mock';
  }

  async chat(req) {
    const started = this.clock();
    this.calls += 1;
    if (!this.cfg.apiKey) {
      if (req.signal && req.signal.aborted) throw new LLMError('aborted before mock call', { retryable: false });
      this.mockCalls += 1;
      const raw = req.mock ? req.mock() : '{}';
      const text = typeof raw === 'string' ? raw : JSON.stringify(raw);
      return { text, provider: 'mock', model: 'mock:' + req.model, latencyMs: this.clock() - started, usage: null };
    }
    const url = this.cfg.baseURL.replace(/\/+$/, '') + '/chat/completions';
    const body = { model: req.model, messages: req.messages, temperature: this.cfg.temperature };
    if (req.json) body.response_format = { type: 'json_object' };
    let attempt = 0;
    let lastErr = null;
    while (attempt <= this.cfg.maxRetries) {
      const ac = new AbortController();
      const timer = setTimeout(() => ac.abort(), this.cfg.timeoutMs);
      if (req.signal) {
        if (req.signal.aborted) {
          clearTimeout(timer);
          throw new LLMError('aborted before call', { retryable: false });
        }
        req.signal.addEventListener('abort', () => ac.abort(), { once: true });
      }
      try {
        const res = await this.fetchImpl(url, {
          method: 'POST',
          headers: { 'content-type': 'application/json', authorization: 'Bearer ' + this.cfg.apiKey },
          body: JSON.stringify(body),
          signal: ac.signal
        });
        if (!res.ok) {
          const text = await res.text().catch(() => '');
          throw new LLMError('HTTP ' + res.status + ' ' + truncate(text, 300), {
            status: res.status,
            retryable: res.status === 429 || res.status >= 500,
            body: text
          });
        }
        const data = await res.json();
        const choice = (data.choices || [])[0] || {};
        const text = (choice.message && choice.message.content) || '';
        return {
          text,
          provider: 'openai',
          model: data.model || req.model,
          latencyMs: this.clock() - started,
          usage: data.usage || null
        };
      } catch (err) {
        lastErr = err;
        const retryable = err instanceof LLMError ? err.retryable : true;
        if (!retryable || attempt === this.cfg.maxRetries) break;
        await new Promise((r) => setTimeout(r, 150 * (attempt + 1)));
        attempt += 1;
      } finally {
        clearTimeout(timer);
      }
    }
    this.errors += 1;
    this.lastError = lastErr ? lastErr.message : 'unknown';
    if (this.logger) this.logger.warn('llm.call_failed', { meta: req.meta || null, error: this.lastError });
    throw lastErr instanceof LLMError ? lastErr : new LLMError(String(lastErr && lastErr.message));
  }

  stats() {
    return { mode: this.mode, calls: this.calls, mockCalls: this.mockCalls, errors: this.errors, lastError: this.lastError };
  }
}

/** Extract the first JSON object from an LLM answer (tolerates code fences and prose). */
export function parseJsonLoose(text) {
  if (!text) return null;
  const s = String(text).trim();
  try { return JSON.parse(s); } catch { /* fall through */ }
  const fenced = s.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fenced) {
    try { return JSON.parse(fenced[1].trim()); } catch { /* fall through */ }
  }
  const start = s.indexOf('{');
  const end = s.lastIndexOf('}');
  if (start >= 0 && end > start) {
    const slice = s.slice(start, end + 1);
    try { return JSON.parse(slice); } catch { /* fall through */ }
  }
  return null;
}
