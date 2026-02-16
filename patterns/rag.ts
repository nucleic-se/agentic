/**
 * RAG (Retrieval-Augmented Generation) Pattern
 *
 * Retrieves relevant documents based on a query, then generates an answer
 * grounded in the retrieved context.
 *
 * Flow: retrieve → rank (optional) → generate
 *
 * @module patterns/rag
 */

import type { GraphState, IGraphEngine } from '../contracts/index.js';
import type { PatternConfig, RetrieverFunction } from './types.js';
import { StateGraphBuilder } from '../runtime/graph/StateGraphBuilder.js';
import { LlmGraphNode } from '../runtime/graph/nodes/LlmGraphNode.js';
import { CallbackGraphNode } from '../runtime/graph/nodes/CallbackGraphNode.js';
import { END } from '../contracts/graph/index.js';

/**
 * State for RAG pattern execution.
 */
export interface RAGState extends GraphState {
    /** User query */
    query: string;
    /** Retrieved documents/chunks */
    documents: string[];
    /** Ranked/filtered documents (if re-ranking enabled) */
    rankedDocuments?: string[];
    /** Generated answer */
    answer: string;
    /** Citations or source references */
    citations?: string[];
}

/**
 * Configuration for RAG pattern.
 */
export interface RAGConfig extends PatternConfig<RAGState> {
    /** Document retriever function */
    retriever: RetrieverFunction;
    /** Number of documents to retrieve (default: 5) */
    topK?: number;
    /** Whether to use LLM for re-ranking documents (default: false) */
    enableReranking?: boolean;
    /** Whether to include citations in the answer (default: false) */
    includeCitations?: boolean;
}

/**
 * Creates a RAG (Retrieval-Augmented Generation) agent.
 *
 * The agent retrieves relevant documents, optionally re-ranks them,
 * then generates an answer grounded in the retrieved context.
 *
 * @example
 * ```ts
 * const agent = createRAGAgent({
 *   llm: myLlm,
 *   retriever: async (query) => {
 *     // Your vector DB or search implementation
 *     return vectorDB.search(query, 5);
 *   },
 *   topK: 5,
 *   enableReranking: true,
 * });
 *
 * const result = await agent.run({
 *   query: 'What is quantum entanglement?',
 *   documents: [], answer: '',
 * });
 * console.log(result.state.answer);
 * ```
 */
export function createRAGAgent(config: RAGConfig): IGraphEngine<RAGState> {
    const topK = config.topK ?? 5;
    const enableReranking = config.enableReranking ?? false;
    const includeCitations = config.includeCitations ?? false;

    // Retrieval node: fetch documents
    const retriever = new CallbackGraphNode<RAGState>('retrieve', async (state) => {
        state.documents = await config.retriever(state.query);

        // Limit to topK if more were returned
        if (state.documents.length > topK) {
            state.documents = state.documents.slice(0, topK);
        }
    });

    // Re-ranking node: use LLM to score and reorder documents
    const reranker = new LlmGraphNode<RAGState>({
        id: 'rerank',
        provider: config.llm,
        prompt: (state) => ({
            instructions: `Rank the following documents by relevance to the query.
Return a JSON array of document indices in order of relevance (most relevant first).

Query: ${state.query}

Documents:
${state.documents.map((doc, i) => `[${i}] ${doc.slice(0, 200)}...`).join('\n\n')}

Respond with JSON:
{
  "rankedIndices": [2, 0, 4, 1, 3]
}`,
            text: '',
            schema: {
                type: 'object',
                properties: {
                    rankedIndices: {
                        type: 'array',
                        items: { type: 'number' },
                    },
                },
                required: ['rankedIndices'],
            },
        }),
        outputKey: 'rankedDocuments',
        temperature: 0.0,
    });

    // Parse reranking results
    const parseReranking = new CallbackGraphNode<RAGState>('parse_reranking', async (state) => {
        try {
            const parsed = typeof state.rankedDocuments === 'string'
                ? JSON.parse(state.rankedDocuments as unknown as string)
                : state.rankedDocuments;

            const indices = parsed.rankedIndices || [];
            state.rankedDocuments = indices
                .map((i: number) => state.documents[i])
                .filter(Boolean);
        } catch {
            // If parsing fails, use original order
            state.rankedDocuments = state.documents;
        }
    });

    // Generation node: create answer from context
    const generator = new LlmGraphNode<RAGState>({
        id: 'generate',
        provider: config.llm,
        prompt: (state) => {
            const docs = state.rankedDocuments || state.documents;
            const context = docs
                .map((doc, i) => `[${i + 1}] ${doc}`)
                .join('\n\n');

            const instructions = includeCitations
                ? `Answer the query using ONLY the provided context. Include citation numbers [1], [2], etc. in your answer.

Context:
${context}

Query: ${state.query}

Respond with JSON:
{
  "answer": "your answer with citations like [1]",
  "citations": ["citation 1", "citation 2"]
}`
                : `Answer the query using ONLY the provided context. Do not use external knowledge.

Context:
${context}

Query: ${state.query}`;

            const schema = includeCitations
                ? {
                    type: 'object',
                    properties: {
                        answer: { type: 'string' },
                        citations: {
                            type: 'array',
                            items: { type: 'string' },
                        },
                    },
                    required: ['answer'],
                }
                : undefined;

            return {
                instructions,
                text: '',
                schema,
            };
        },
        outputKey: 'answer',
        temperature: 0.3,
    });

    // Parse answer if citations enabled
    const parseAnswer = new CallbackGraphNode<RAGState>('parse_answer', async (state) => {
        if (includeCitations) {
            try {
                const parsed = typeof state.answer === 'string'
                    ? JSON.parse(state.answer)
                    : state.answer;

                state.citations = parsed.citations || [];
                state.answer = parsed.answer || state.answer;
            } catch {
                // Keep answer as-is
            }
        }
    });

    const builder = new StateGraphBuilder<RAGState>()
        .addNode(retriever)
        .addNode(generator)
        .setEntry('retrieve');

    if (enableReranking) {
        builder
            .addNode(reranker)
            .addNode(parseReranking)
            .addEdge('retrieve', 'rerank')
            .addEdge('rerank', 'parse_reranking')
            .addEdge('parse_reranking', 'generate');
    } else {
        builder.addEdge('retrieve', 'generate');
    }

    if (includeCitations) {
        builder
            .addNode(parseAnswer)
            .addEdge('generate', 'parse_answer');
    }

    return builder.build({
        maxSteps: 10,
        tracer: config.tracer,
    });
}
