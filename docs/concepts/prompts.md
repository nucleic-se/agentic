# Prompt engine

`PromptEngine` assembles a prompt from multiple ranked sections under a token budget. It is the right tool when you need to fit variable-length content (history, memory, retrieved docs) into a finite context window without hard-coding truncation logic.

---

## Core idea

Each section has a `priority` (0–100) and `weight` (multiplier). Sections are scored by `priority × weight` and included from highest to lowest until the token budget is exhausted. **Sticky sections are always included**, regardless of score.

---

## Basic usage

```ts
import { PromptEngine } from '@nucleic-se/agentic/runtime';
import type { PromptSection } from '@nucleic-se/agentic/contracts';

const engine = new PromptEngine();

const sections: PromptSection[] = [
  {
    id: 'system',
    text: () => 'You are a helpful research assistant.',
    priority: 100,
    weight: 1,
    estimatedTokens: 10,
    sticky: true,        // Always included
    tags: [],
  },
  {
    id: 'task',
    text: () => `Research: ${topic}`,
    priority: 90,
    weight: 1,
    estimatedTokens: 20,
    tags: ['task'],
  },
  {
    id: 'history',
    text: () => conversationHistory,
    priority: 20,
    weight: 1,
    estimatedTokens: estimateTokens(conversationHistory),
    tags: ['history'],
    phase: 'history',
  },
  {
    id: 'retrieved-docs',
    text: () => docs.join('\n\n'),
    priority: 50,
    weight: 1,
    estimatedTokens: estimateTokens(docs.join('\n\n')),
    tags: ['context'],
    phase: 'memory',
  },
];

const { text, included, excluded, totalTokens } = engine.compose(sections, 8_000);
```

`text` is the final prompt string. `included` and `excluded` list which sections made it in or were dropped.

---

## PromptSection fields

| Field | Type | Required | Description |
|---|---|---|---|
| `id` | `string` | Yes | Unique identifier |
| `text` | `() => string` | Yes | Renders the section content |
| `priority` | `number` | Yes | Base importance (0–100) |
| `weight` | `number` | Yes | Multiplier applied to priority |
| `estimatedTokens` | `number` | Yes | Pre-computed token estimate |
| `sticky` | `boolean` | No | If true, always included |
| `tags` | `string[]` | Yes | Metadata for filtering/debugging |
| `phase` | `PromptSectionPhase` | No | Layout ordering hint |
| `contextMultiplier` | `number` | No | Dynamic relevance boost/decay |

---

## Phase ordering

`phase` controls where in the assembled prompt a section appears, regardless of score:

| Phase | Position |
|---|---|
| `'constraint'` | First — system rules, instructions |
| `'task'` | Second — the current task |
| `'memory'` | Third — retrieved context, past notes |
| `'tools'` | Fourth — tool descriptions |
| `'history'` | Fifth — conversation history |
| `'user'` | Last — the immediate user message |

---

## Token estimation

Use the built-in helper for a rough estimate (≈4 chars per token):

```ts
import { estimateTokens } from '@nucleic-se/agentic';

const tokens = estimateTokens('This is approximately 10 tokens.');
```

For accurate counts, use your provider's tokeniser and cache the result.

---

## Dynamic weight

Adjust `weight` at runtime to boost or suppress sections based on context:

```ts
const memorySection: PromptSection = {
  id: 'memory',
  text: () => memory.join('\n'),
  priority: 50,
  weight: hasRelevantMemory ? 1.5 : 0.5,  // Boost when memory is relevant
  estimatedTokens: ...,
  tags: ['memory'],
};
```

---

## PromptComposeResult

```ts
interface PromptComposeResult {
  text: string;                   // Final assembled prompt
  included: PromptSection[];      // Sections that made it in
  excluded: PromptSection[];      // Sections dropped due to budget
  totalTokens: number;            // Estimated total tokens used
}
```

---

## IPromptContributor

For large systems, register contributors that supply sections on demand:

```ts
import type { IPromptContributor, PromptContributionContext } from '@nucleic-se/agentic/contracts';
import { PromptContributorRegistry } from '@nucleic-se/agentic/runtime';

class MemoryContributor implements IPromptContributor {
  readonly id = 'memory';

  async contribute(ctx: PromptContributionContext): Promise<PromptSection[]> {
    const items = await memory.query({ limit: 10 });
    return items.map(item => ({
      id: `mem-${item.id}`,
      text: () => `${item.key}: ${item.value}`,
      priority: 40,
      weight: item.confidence,
      estimatedTokens: estimateTokens(String(item.value)),
      tags: ['memory'],
      phase: 'memory',
    }));
  }
}

const registry = new PromptContributorRegistry();
registry.register(new MemoryContributor());

// Collect from all contributors
const sections = await registry.collect(ctx);
const { text } = engine.compose(sections, 8_000);
```
