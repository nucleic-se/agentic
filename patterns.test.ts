/**
 * Tests for agentic design patterns
 */

import { describe, it, expect } from 'vitest';
import {
    createReActAgent,
    createPlanExecuteAgent,
    createReflectionAgent,
    createRAGAgent,
    createChainOfThoughtAgent,
    createHumanInLoopAgent,
} from './patterns/index.js';
import type { ILLMProvider, StructuredRequest } from './contracts/index.js';

// Mock LLM provider for testing
class MockLLMProvider implements ILLMProvider {
    async structured(request: StructuredRequest) {
        const system = request.system ?? '';
        // Return canned responses based on system instructions
        if (system.includes('Think step-by-step')) {
            return { value: {
                thought: 'I need to use the calculate tool',
                action: 'calculate',
                actionInput: '240 * 0.15',
            }, usage: { inputTokens: 0, outputTokens: 0 } };
        }

        if (system.includes('Break down the problem')) {
            return { value: {
                steps: ['Step 1: Understand the problem', 'Step 2: Solve it'],
            }, usage: { inputTokens: 0, outputTokens: 0 } };
        }

        if (system.includes('Critique the draft')) {
            return { value: {
                quality: 9,
                feedback: 'Looks good!',
            }, usage: { inputTokens: 0, outputTokens: 0 } };
        }

        if (system.includes('Create a detailed step-by-step plan')) {
            return { value: {
                steps: ['Research the topic', 'Write the content', 'Review and edit'],
            }, usage: { inputTokens: 0, outputTokens: 0 } };
        }

        if (system.includes('Review the execution progress')) {
            return { value: {
                decision: 'FINISH',
                reasoning: 'All steps complete',
            }, usage: { inputTokens: 0, outputTokens: 0 } };
        }

        // Default response
        return { value: 'Mock response', usage: { inputTokens: 0, outputTokens: 0 } };
    }

    async turn() {
        return {
            message: { role: 'assistant' as const, content: 'ok', toolCalls: [] },
            stopReason: 'end_turn' as const,
            usage: { inputTokens: 0, outputTokens: 0 },
        };
    }

    async embed(_texts: string[]): Promise<number[][]> {
        return [[0.1, 0.2, 0.3]];
    }
}

describe('Agentic Patterns', () => {
    describe('ReAct Pattern', () => {
        it('should execute reason-act cycles', async () => {
            const llm = new MockLLMProvider();

            const agent = createReActAgent({
                llm,
                tools: {
                    calculate: async (expr: string) => {
                        return eval(expr).toString();
                    },
                },
                maxIterations: 2,
            });

            const result = await agent.run({
                goal: 'What is 15% of 240?',
                thought: '',
                action: '',
                actionInput: '',
                observation: '',
                answer: '',
                iteration: 0,
            });

            expect(result.state.observation).toBeDefined();
            expect(result.steps).toBeGreaterThan(0);
        });
    });

    describe('Plan-Execute Pattern', () => {
        it('handles empty plan without calling executor', async () => {
            const llm = new MockLLMProvider();
            // Override structured() to return an empty plan
            llm.structured = async () => ({ value: { steps: [] }, usage: { inputTokens: 0, outputTokens: 0 } });

            let executorCallCount = 0;
            const agent = createPlanExecuteAgent({
                llm,
                executor: async (step) => {
                    executorCallCount++;
                    return `Completed: ${step}`;
                },
                enableReview: false,
            });

            const result = await agent.run({
                objective: 'Do something',
                plan: [],
                currentStep: 0,
                results: [],
                review: '',
                shouldReplan: false,
            });

            expect(executorCallCount).toBe(0);
            expect(result.state.plan).toHaveLength(0);
            expect(result.state.currentStep).toBe(0);
        });

        it('should create and execute a plan', async () => {
            const llm = new MockLLMProvider();

            let executedSteps: string[] = [];

            const agent = createPlanExecuteAgent({
                llm,
                executor: async (step, ctx) => {
                    executedSteps.push(step);
                    return `Completed: ${step}`;
                },
                enableReview: true,
                maxIterations: 5,
            });

            const result = await agent.run({
                objective: 'Write a blog post',
                plan: [],
                currentStep: 0,
                results: [],
                review: '',
                shouldReplan: false,
            });

            expect(result.state.plan.length).toBeGreaterThan(0);
            expect(executedSteps.length).toBeGreaterThan(0);
        });
    });

    describe('Reflection Pattern', () => {
        it('should iteratively refine output', async () => {
            const llm = new MockLLMProvider();

            const agent = createReflectionAgent({
                llm,
                qualityThreshold: 8,
                maxRounds: 2,
            });

            const result = await agent.run({
                task: 'Write a haiku',
                draft: '',
                critique: '',
                quality: 0,
                iteration: 0,
            });

            expect(result.state.draft).toBeDefined();
            expect(result.state.quality).toBeGreaterThanOrEqual(0);
        });
    });

    describe('RAG Pattern', () => {
        it('should retrieve and generate answer', async () => {
            const llm = new MockLLMProvider();

            const agent = createRAGAgent({
                llm,
                retriever: async (query) => {
                    return [
                        'Document 1: Quantum entanglement is a phenomenon...',
                        'Document 2: In quantum physics...',
                    ];
                },
                topK: 2,
            });

            const result = await agent.run({
                query: 'What is quantum entanglement?',
                documents: [],
                answer: '',
            });

            expect(result.state.documents.length).toBe(2);
            expect(result.state.answer).toBeDefined();
        });
    });

    describe('Chain-of-Thought Pattern', () => {
        it('skips reasoning and synthesizes directly when steps is empty', async () => {
            const llm = new MockLLMProvider();
            // Override structured() to return empty steps from the decomposer
            llm.structured = async () => ({ value: { steps: [] }, usage: { inputTokens: 0, outputTokens: 0 } });

            const agent = createChainOfThoughtAgent({ llm });

            const result = await agent.run({
                problem: 'trivial',
                steps: [],
                currentStep: 0,
                stepReasoning: [],
                answer: '',
            });

            // No reasoning steps should have been recorded
            expect(result.state.stepReasoning).toHaveLength(0);
            expect(result.state.currentStep).toBe(0);
            // Synthesizer still ran and produced an answer
            expect(result.state.answer).toBeDefined();
        });

        it('should decompose and reason through steps', async () => {
            const llm = new MockLLMProvider();

            const agent = createChainOfThoughtAgent({
                llm,
                maxSteps: 3,
            });

            const result = await agent.run({
                problem: 'How many apples total if Alice has 3 and Bob has twice as many?',
                steps: [],
                currentStep: 0,
                stepReasoning: [],
                answer: '',
            });

            expect(result.state.steps.length).toBeGreaterThan(0);
            expect(result.state.stepReasoning.length).toBeGreaterThan(0);
            expect(result.state.answer).toBeDefined();
        });
    });

    describe('Human-in-the-Loop Pattern', () => {
        it('should incorporate human feedback', async () => {
            const llm = new MockLLMProvider();

            let feedbackRequested = false;

            const agent = createHumanInLoopAgent({
                llm,
                requestHumanInput: async (prompt) => {
                    feedbackRequested = true;
                    return 'approve'; // Auto-approve for test
                },
                maxIterations: 2,
            });

            const result = await agent.run({
                task: 'Draft an email',
                proposal: '',
                humanFeedback: '',
                approved: false,
                result: '',
                iteration: 0,
            });

            expect(feedbackRequested).toBe(true);
            expect(result.state.approved).toBe(true);
            expect(result.state.result).toBeDefined();
        });
    });
});
