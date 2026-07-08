export type ToolCursor = 'default' | 'crosshair' | 'pointer' | 'move' | 'grab' | 'grabbing' | 'not-allowed' | 'zoom-in' | 'zoom-out' | 'text' | 'custom';

export interface ToolKeyEvent {
  type: 'keydown' | 'keyup';
  key: string;
  code: string;
  shiftKey: boolean;
  ctrlKey: boolean;
  altKey: boolean;
  metaKey: boolean;
  preventDefault: () => void;
}

export interface ToolPointerEvent {
  type: 'pointerdown' | 'pointermove' | 'pointerup' | 'click' | 'dblclick' | 'contextmenu';
  screenX: number;
  screenY: number;
  worldX: number;
  worldY: number;
  button: number;
  shiftKey: boolean;
  ctrlKey: boolean;
  altKey: boolean;
  metaKey: boolean;
  preventDefault: () => void;
  stopPropagation: () => void;
}

export interface Tool {
  readonly id: string;
  readonly name: string;
  readonly icon?: string;
  readonly description?: string;
  readonly cursor: ToolCursor;
  readonly shortcut?: string;

  activate(context: ToolContext): void;
  deactivate(): void;

  onPointerDown?(event: ToolPointerEvent): void;
  onPointerMove?(event: ToolPointerEvent): void;
  onPointerUp?(event: ToolPointerEvent): void;
  onClick?(event: ToolPointerEvent): void;
  onDoubleClick?(event: ToolPointerEvent): void;
  onKeyDown?(event: ToolKeyEvent): void;
  onKeyUp?(event: ToolKeyEvent): void;

  isActive(): boolean;
}

export interface ToolContext {
  getActiveLayerId(): string | null;
  getSelectedEntityIds(): string[];
  selectEntity(id: string, multi?: boolean): void;
  deselectAll(): void;
  getViewport(): { centerX: number; centerY: number; zoom: number; width: number; height: number };
  setViewport(centerX: number, centerY: number, zoom: number): void;
  screenToWorld(screenX: number, screenY: number): { x: number; y: number };
  worldToScreen(worldX: number, worldY: number): { x: number; y: number };
  emitEvent(eventName: string, payload?: unknown): void;
}

export class ToolRegistry {
  private tools: Map<string, Tool> = new Map();
  private activeTool: Tool | null = null;
  private context: ToolContext | null = null;
  private toolChangeHandlers: Set<(tool: Tool | null) => void> = new Set();

  register(tool: Tool): void {
    if (this.tools.has(tool.id)) {
      console.warn(`[ToolRegistry] Tool "${tool.id}" already registered, overwriting.`);
    }
    this.tools.set(tool.id, tool);
  }

  unregister(toolId: string): void {
    if (this.activeTool?.id === toolId) {
      this.deactivateTool();
    }
    this.tools.delete(toolId);
  }

  get(toolId: string): Tool | undefined {
    return this.tools.get(toolId);
  }

  getAll(): Tool[] {
    return Array.from(this.tools.values());
  }

  getActiveTool(): Tool | null {
    return this.activeTool;
  }

  setContext(context: ToolContext): void {
    this.context = context;
  }

  activateTool(toolId: string): boolean {
    const tool = this.tools.get(toolId);
    if (!tool) return false;

    if (this.activeTool) {
      this.activeTool.deactivate();
    }

    this.activeTool = tool;
    if (this.context) {
      tool.activate(this.context);
    }

    this.toolChangeHandlers.forEach(handler => {
      try {
        handler(tool);
      } catch (err) {
        console.error('[ToolRegistry] Error in tool change handler:', err);
      }
    });

    return true;
  }

  deactivateTool(): void {
    if (this.activeTool) {
      this.activeTool.deactivate();
      this.activeTool = null;

      this.toolChangeHandlers.forEach(handler => {
        try {
          handler(null);
        } catch (err) {
          console.error('[ToolRegistry] Error in tool change handler:', err);
        }
      });
    }
  }

  onToolChange(handler: (tool: Tool | null) => void): () => void {
    this.toolChangeHandlers.add(handler);
    return () => {
      this.toolChangeHandlers.delete(handler);
    };
  }

  dispatchPointerEvent(event: ToolPointerEvent): void {
    if (!this.activeTool) return;

    switch (event.type) {
      case 'pointerdown':
        this.activeTool.onPointerDown?.(event);
        break;
      case 'pointermove':
        this.activeTool.onPointerMove?.(event);
        break;
      case 'pointerup':
        this.activeTool.onPointerUp?.(event);
        break;
      case 'click':
        this.activeTool.onClick?.(event);
        break;
      case 'dblclick':
        this.activeTool.onDoubleClick?.(event);
        break;
    }
  }

  dispatchKeyEvent(event: ToolKeyEvent): void {
    if (!this.activeTool) return;

    switch (event.type) {
      case 'keydown':
        this.activeTool.onKeyDown?.(event);
        break;
      case 'keyup':
        this.activeTool.onKeyUp?.(event);
        break;
    }
  }

  destroy(): void {
    this.deactivateTool();
    this.tools.clear();
    this.toolChangeHandlers.clear();
    this.context = null;
  }
}

export const toolRegistry = new ToolRegistry();
