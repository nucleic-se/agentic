/**
 * In-memory typed tool registry.
 *
 * @module runtime
 */

import type { ITool, IToolRegistry } from '../contracts/ITool.js';

export class ToolRegistry implements IToolRegistry {
    private readonly tools = new Map<string, ITool>();

    register(tool: ITool): void {
        if (this.tools.has(tool.name)) {
            throw new Error(`ToolRegistry: Tool '${tool.name}' is already registered.`);
        }
        this.tools.set(tool.name, tool);
    }

    resolve(name: string): ITool | undefined {
        return this.tools.get(name);
    }

    list(): ITool[] {
        return Array.from(this.tools.values());
    }
}
