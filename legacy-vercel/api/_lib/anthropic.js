// api/_lib/anthropic.js
// Direct Anthropic Messages API client. No SDK wrappers, no emergentintegrations.
// Endpoint: https://api.anthropic.com/v1/messages
// Default model: claude-sonnet-4-6 (per spec).

const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY;
const DEFAULT_MODEL     = 'claude-sonnet-4-6';
const API_URL           = 'https://api.anthropic.com/v1/messages';
const API_VERSION       = '2023-06-01';

/**
 * Call Anthropic /v1/messages directly.
 *
 * @param {Object}   opts
 * @param {string}   opts.system        - System prompt (Sara's voice instructions).
 * @param {Array}    opts.messages      - [{ role: 'user'|'assistant', content: '...' }]
 * @param {string=}  opts.model         - Defaults to claude-sonnet-4-6.
 * @param {number=}  opts.max_tokens    - Defaults to 1024.
 * @param {number=}  opts.temperature   - Defaults to 0.7.
 * @returns {Promise<{ text: string, raw: any }>}
 */
export async function anthropicMessage({ system, messages, model, max_tokens, temperature }) {
  if (!ANTHROPIC_API_KEY) {
    throw new Error('ANTHROPIC_API_KEY is not configured');
  }

  const body = {
    model:       model       || DEFAULT_MODEL,
    max_tokens:  max_tokens  ?? 1024,
    temperature: temperature ?? 0.7,
    system:      system      || undefined,
    messages
  };

  const res = await fetch(API_URL, {
    method: 'POST',
    headers: {
      'content-type':      'application/json',
      'x-api-key':         ANTHROPIC_API_KEY,
      'anthropic-version': API_VERSION
    },
    body: JSON.stringify(body)
  });

  if (!res.ok) {
    const errText = await res.text();
    throw new Error(`Anthropic API ${res.status}: ${errText}`);
  }

  const json = await res.json();
  // Concatenate all text blocks in the response
  const text = (json.content || [])
    .filter(b => b.type === 'text')
    .map(b => b.text)
    .join('');

  return { text, raw: json };
}

/**
 * Convenience: ask for a JSON object back and parse it.
 * Strips ```json fences if present.
 */
export async function anthropicJSON(opts) {
  const { text, raw } = await anthropicMessage(opts);
  const cleaned = text
    .replace(/^```(?:json)?\s*/i, '')
    .replace(/\s*```$/i, '')
    .trim();
  try {
    return { json: JSON.parse(cleaned), text, raw };
  } catch (e) {
    // Fallback: try to extract the first {...} block
    const match = cleaned.match(/\{[\s\S]*\}/);
    if (match) {
      return { json: JSON.parse(match[0]), text, raw };
    }
    throw new Error(`Anthropic JSON parse failed: ${e.message}\nResponse text:\n${text}`);
  }
}
