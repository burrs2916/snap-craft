import type { Tool, ToolPointerEvent, ToolKeyEvent, ToolContext } from "./Tool";

export class PanTool implements Tool {
  readonly id = 'pan';
  readonly name = '平移';
  readonly icon = 'PanToolAlt';
  readonly cursor = 'grab' as const;
  readonly shortcut = 'H';

  private _context: ToolContext | null = null;
  private _isPanning = false;
  private _lastX = 0;
  private _lastY = 0;

  activate(context: ToolContext): void {
    this._context = context;
  }

  deactivate(): void {
    this._isPanning = false;
    this._context = null;
  }

  isActive(): boolean {
    return this._context !== null;
  }

  onPointerDown(event: ToolPointerEvent): void {
    if (event.button === 0 || event.button === 1) {
      this._isPanning = true;
      this._lastX = event.screenX;
      this._lastY = event.screenY;
      event.preventDefault();
    }
  }

  onPointerMove(event: ToolPointerEvent): void {
    if (!this._isPanning || !this._context) return;

    const dx = event.screenX - this._lastX;
    const dy = event.screenY - this._lastY;
    this._lastX = event.screenX;
    this._lastY = event.screenY;

    const viewport = this._context.getViewport();
    const worldDx = dx / viewport.zoom;
    const worldDy = dy / viewport.zoom;
    this._context.setViewport(
      viewport.centerX - worldDx,
      viewport.centerY + worldDy,
      viewport.zoom
    );
  }

  onPointerUp(_event: ToolPointerEvent): void {
    this._isPanning = false;
  }
}

export class ZoomTool implements Tool {
  readonly id = 'zoom';
  readonly name = '缩放';
  readonly icon = 'ZoomIn';
  readonly cursor = 'zoom-in' as const;
  readonly shortcut = 'Z';

  private _context: ToolContext | null = null;

  activate(context: ToolContext): void {
    this._context = context;
  }

  deactivate(): void {
    this._context = null;
  }

  isActive(): boolean {
    return this._context !== null;
  }

  onClick(event: ToolPointerEvent): void {
    if (!this._context) return;

    const viewport = this._context.getViewport();
    const zoomFactor = event.shiftKey ? 0.8 : 1.25;
    const newZoom = viewport.zoom * zoomFactor;

    const worldPos = this._context.screenToWorld(event.screenX, event.screenY);
    const newCenterX = worldPos.x + (viewport.centerX - worldPos.x) / zoomFactor;
    const newCenterY = worldPos.y + (viewport.centerY - worldPos.y) / zoomFactor;

    this._context.setViewport(newCenterX, newCenterY, newZoom);
  }
}

export class SelectTool implements Tool {
  readonly id = 'select';
  readonly name = '选择';
  readonly icon = 'NearMe';
  readonly cursor = 'default' as const;
  readonly shortcut = 'V';

  private _context: ToolContext | null = null;
  private _isBoxSelecting = false;
  private _boxStartX = 0;
  private _boxStartY = 0;

  activate(context: ToolContext): void {
    this._context = context;
  }

  deactivate(): void {
    this._isBoxSelecting = false;
    this._context = null;
  }

  isActive(): boolean {
    return this._context !== null;
  }

  onPointerDown(event: ToolPointerEvent): void {
    if (event.button !== 0 || !this._context) return;

    if (event.shiftKey) {
      this._isBoxSelecting = true;
      this._boxStartX = event.screenX;
      this._boxStartY = event.screenY;
      event.preventDefault();
    }
  }

  onPointerMove(_event: ToolPointerEvent): void {
    // Future: draw selection rectangle overlay
  }

  onPointerUp(event: ToolPointerEvent): void {
    if (!this._context) return;

    if (this._isBoxSelecting) {
      this._isBoxSelecting = false;
      this._context.emitEvent('boxSelect', {
        startX: this._boxStartX,
        startY: this._boxStartY,
        endX: event.screenX,
        endY: event.screenY,
      });
      return;
    }
  }

  onClick(event: ToolPointerEvent): void {
    if (!this._context) return;

    const worldPos = this._context.screenToWorld(event.screenX, event.screenY);
    this._context.emitEvent('pick', {
      screenX: event.screenX,
      screenY: event.screenY,
      worldX: worldPos.x,
      worldY: worldPos.y,
      multi: event.shiftKey || event.ctrlKey,
    });
  }

  onKeyDown(event: ToolKeyEvent): void {
    if (event.key === 'Escape' && this._context) {
      this._context.deselectAll();
    }

    if (event.key === 'a' && (event.ctrlKey || event.metaKey) && this._context) {
      event.preventDefault();
      this._context.emitEvent('selectAll', {});
    }
  }
}
