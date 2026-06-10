import {
  Component,
  ElementRef,
  HostListener,
  input,
  output,
  ViewChild,
  AfterViewInit,
  OnDestroy,
  signal,
  effect,
} from '@angular/core';
import { DecimalPipe } from '@angular/common';
import { Canvas, Rect, Polygon, Circle, Polyline, Line, FabricImage, Point } from 'fabric';

export interface RectOptions {
  x: number;
  y: number;
  width: number;
  height: number;
  stroke?: string;
  fill?: string;
  fillOpacity?: number;
  strokeWidth?: number;
}

export interface PolyOptions {
  points: { x: number; y: number }[];
  stroke?: string;
  fill?: string;
  fillOpacity?: number;
  strokeWidth?: number;
}

export interface LayerInfo {
  index: number;
  name: string;
  type: string;
  x: number;
  y: number;
  width?: number;
  height?: number;
  points?: { x: number; y: number }[];
  stroke: string;
  fill: string;
  strokeWidth: number;
  visible: boolean;
}


interface ColorPreset {
  name: string;
  stroke: string;
  fill: string;
}

@Component({
  selector: 'app-canvas-editor',
  standalone: true,
  imports: [DecimalPipe],
  templateUrl: './canvas-editor.component.html',
})
export class CanvasEditorComponent implements AfterViewInit, OnDestroy {
  imageSrc = input.required<string>();
  canvasData = input<string | undefined>();

  save = output<string>();
  layersChange = output<any[]>();

  @ViewChild('editorCanvas') canvasElement!: ElementRef<HTMLCanvasElement>;
  @ViewChild('canvasContainer') canvasContainerElement!: ElementRef<HTMLDivElement>;

  protected readonly activeTool = signal<'select' | 'rect' | 'polygon'>('select');
  protected readonly selectedPresetName = signal<string>('Indigo');
  protected readonly isObjectSelected = signal<boolean>(false);

  // Layers list representing canvas objects
  protected readonly layers = signal<any[]>([]);

  // Advanced customization styles (hidden inside a popover menu by default)
  protected readonly strokeColor = signal<string>('#4f46e5');
  protected readonly fillColor = signal<string>('#818cf8');
  protected readonly fillOpacity = signal<number>(0.2);
  protected readonly strokeWidth = signal<number>(3);
  protected readonly showAdvancedStyles = signal<boolean>(false);

  protected readonly colorPresets: ColorPreset[] = [
    { name: 'Indigo', stroke: '#4f46e5', fill: '#818cf8' },
    { name: 'Emerald', stroke: '#059669', fill: '#34d399' },
    { name: 'Violet', stroke: '#7c3aed', fill: '#a78bfa' },
    { name: 'Rose', stroke: '#e11d48', fill: '#fb7185' },
    { name: 'Amber', stroke: '#d97706', fill: '#fbbf24' },
    { name: 'Slate', stroke: '#475569', fill: '#94a3b8' },
  ];

  private canvas: Canvas | null = null;
  private savedPayload: any = null;
  private backgroundImageObject: FabricImage | null = null;
  private isViewInitialized = false;

  // Drawing state trackers
  private isDrawingRect = false;
  private rectStartPoint = { x: 0, y: 0 };
  private activeRectObject: Rect | null = null;

  private isDrawingPolygon = false;
  private polygonPoints: { x: number; y: number }[] = [];
  private activePolyline: Polyline | null = null;
  private guideLine: Line | null = null;
  private startCircle: Circle | null = null;

  // Zoom & Pan state trackers
  private isSpacePressed = false;
  private isPanning = false;
  private lastPosX = 0;
  private lastPosY = 0;

  private resizeObserver: ResizeObserver | null = null;

  constructor() {
    // Sync draw tool change behaviors (e.g. clear selection)
    effect(() => {
      const tool = this.activeTool();
      this.onToolChanged(tool);
    });

    // Parse initial canvas data if present
    effect(() => {
      const data = this.canvasData();
      if (data) {
        try {
          this.savedPayload = JSON.parse(data);
        } catch (e) {
          console.error('Error parsing initial canvas data in editor', e);
          this.savedPayload = null;
        }
      } else {
        this.savedPayload = null;
      }
    });

    // Initialize canvas on image source changes
    effect(() => {
      const src = this.imageSrc();
      if (this.isViewInitialized) {
        this.initCanvasAndImage();
      }
    });
  }

  ngAfterViewInit(): void {
    this.isViewInitialized = true;

    // Observe size changes from the start
    const container = this.canvasContainerElement?.nativeElement;
    if (container) {
      if (this.resizeObserver) {
        this.resizeObserver.disconnect();
      }
      this.resizeObserver = new ResizeObserver(() => {
        this.handleResize();
      });
      this.resizeObserver.observe(container);
    }

    this.initCanvasAndImage();
  }

  ngOnDestroy(): void {
    if (this.resizeObserver) {
      this.resizeObserver.disconnect();
      this.resizeObserver = null;
    }
    if (this.canvas) {
      this.canvas.dispose();
      this.canvas = null;
    }
  }

  @HostListener('window:resize')
  onResize(): void {
    this.handleResize();
  }

  @HostListener('document:keydown', ['$event'])
  onKeyDown(event: KeyboardEvent): void {
    // Handle Spacebar down for panning mode
    if (event.code === 'Space') {
      this.isSpacePressed = true;
      if (this.canvas) {
        this.canvas.defaultCursor = 'grab';
        // Only prevent page scrolling if focus is NOT on a text input/textarea
        const isInputActive = ['INPUT', 'TEXTAREA', 'SELECT'].includes(
          document.activeElement?.tagName || ''
        );
        if (!isInputActive) {
          event.preventDefault();
        }
      }
      return;
    }

    // Handle escape during drawing
    if (event.key === 'Escape') {
      if (this.isDrawingPolygon) {
        this.cancelPolygonDrawing();
      } else if (this.isDrawingRect) {
        this.cancelRectDrawing();
      }
      return;
    }

    // Handle enter to close polygon
    if (event.key === 'Enter' && this.isDrawingPolygon && this.polygonPoints.length >= 3) {
      this.finishPolygonDrawing();
      return;
    }

    // Handle delete/backspace to remove selected shape
    const isInputActive = ['INPUT', 'TEXTAREA', 'SELECT'].includes(
      document.activeElement?.tagName || ''
    );
    if (!isInputActive && (event.key === 'Delete' || event.key === 'Backspace')) {
      this.deleteSelected();
    }
  }

  @HostListener('document:keyup', ['$event'])
  onKeyUp(event: KeyboardEvent): void {
    // Release Spacebar for panning mode
    if (event.code === 'Space') {
      this.isSpacePressed = false;
      if (this.canvas) {
        this.canvas.defaultCursor = 'default';
      }
    }
  }

  protected async initCanvasAndImage(): Promise<void> {
    if (!this.canvasElement) return;

    const container = this.canvasContainerElement?.nativeElement;
    if (!container) return;

    const width = container.clientWidth;
    const height = container.clientHeight;

    if (width === 0 || height === 0) {
      await new Promise<void>((resolve) => {
        requestAnimationFrame(async () => {
          await this.initCanvasAndImage();
          resolve();
        });
      });
      return;
    }

    if (this.canvas) {
      this.canvas.dispose();
      this.canvas = null;
    }

    this.canvas = new Canvas(this.canvasElement.nativeElement, {
      width,
      height,
      selection: this.activeTool() === 'select',
    });

    // Reset viewport transforms and zoom factors
    this.canvas.setZoom(1);
    this.canvas.setViewportTransform([1, 0, 0, 1, 0, 0]);

    // Load background image
    const imgElement = new Image();
    imgElement.src = this.imageSrc();
    try {
      await new Promise<void>((resolve, reject) => {
        imgElement.onload = () => resolve();
        imgElement.onerror = (err) => reject(err);
      });
    } catch (e) {
      console.error('Failed to load image element', e);
      return;
    }

    const fabricImg = new FabricImage(imgElement, {
      left: 0,
      top: 0,
      width: imgElement.naturalWidth || imgElement.width || 800,
      height: imgElement.naturalHeight || imgElement.height || 600,
      originX: 'left',
      originY: 'top',
      selectable: false,
      evented: false,
      excludeFromExport: true,
      hoverCursor: 'default',
    });

    // Bind Fabric Canvas events
    this.canvas.on('mouse:down', (opt) => this.onMouseDown(opt));
    this.canvas.on('mouse:move', (opt) => this.onMouseMove(opt));
    this.canvas.on('mouse:up', (opt) => this.onMouseUp(opt));
    this.canvas.on('mouse:dblclick', () => this.onDoubleClick());

    // Prevent shapes from being moved out of the image boundaries
    this.canvas.on('object:moving', (e) => {
      const obj = e.target;
      if (!obj || obj === this.backgroundImageObject) return;

      const imgWidth = this.backgroundImageObject?.width || 800;
      const imgHeight = this.backgroundImageObject?.height || 600;

      const w = obj.getScaledWidth();
      const h = obj.getScaledHeight();

      let minX = obj.left;
      let minY = obj.top;

      if (obj.originX === 'center') {
        minX = obj.left - w / 2;
      }
      if (obj.originY === 'center') {
        minY = obj.top - h / 2;
      }

      const maxX = minX + w;
      const maxY = minY + h;

      let adjustX = 0;
      let adjustY = 0;

      if (minX < 0) {
        adjustX = -minX;
      } else if (maxX > imgWidth) {
        adjustX = imgWidth - maxX;
      }

      if (minY < 0) {
        adjustY = -minY;
      } else if (maxY > imgHeight) {
        adjustY = imgHeight - maxY;
      }

      if (adjustX !== 0 || adjustY !== 0) {
        obj.set({
          left: obj.left + adjustX,
          top: obj.top + adjustY
        });
        obj.setCoords();
      }
    });

    // Prevent shapes from being scaled out of the image boundaries
    this.canvas.on('object:scaling', (e) => {
      const obj = e.target as any;
      if (!obj || obj === this.backgroundImageObject) return;

      const imgWidth = this.backgroundImageObject?.width || 800;
      const imgHeight = this.backgroundImageObject?.height || 600;

      const w = obj.getScaledWidth();
      const h = obj.getScaledHeight();

      let minX = obj.left;
      let minY = obj.top;

      if (obj.originX === 'center') {
        minX = obj.left - w / 2;
      }
      if (obj.originY === 'center') {
        minY = obj.top - h / 2;
      }

      const maxX = minX + w;
      const maxY = minY + h;

      if (minX < 0 || maxX > imgWidth || minY < 0 || maxY > imgHeight) {
        if (obj._lastValidState) {
          obj.set(obj._lastValidState);
          obj.setCoords();
        }
      } else {
        obj._lastValidState = {
          scaleX: obj.scaleX,
          scaleY: obj.scaleY,
          left: obj.left,
          top: obj.top,
        };
      }
    });

    // Bind Mouse Scroll Wheel Zooming
    this.canvas.on('mouse:wheel', (opt) => {
      const delta = opt.e.deltaY;
      let zoom = this.canvas!.getZoom();
      zoom *= 0.999 ** delta;
      
      // Limit zoom between 5% and 2000%
      if (zoom > 20) zoom = 20;
      if (zoom < 0.05) zoom = 0.05;
      
      this.canvas!.zoomToPoint(new Point(opt.e.offsetX, opt.e.offsetY), zoom);
      opt.e.preventDefault();
      opt.e.stopPropagation();
    });

    // Layer list sync and auto-save on modifications
    this.canvas.on('object:added', () => {
      this.updateLayersList();
      this.autoSave();
    });
    this.canvas.on('object:modified', () => {
      this.updateLayersList();
      this.autoSave();
    });
    this.canvas.on('object:removed', () => {
      this.updateLayersList();
      this.autoSave();
    });

    // Selection indicators for UI state & Layer highlight
    const updateSelectionState = () => {
      this.isObjectSelected.set(this.canvas?.getActiveObjects().length! > 0);
      this.updateLayersList();
    };

    this.canvas.on('selection:created', updateSelectionState);
    this.canvas.on('selection:updated', updateSelectionState);
    this.canvas.on('selection:cleared', updateSelectionState);

    // If initial payload exists, load it
    if (this.savedPayload) {
      try {
        if (this.savedPayload.viewportTransform) {
          delete this.savedPayload.viewportTransform;
        }
        await this.canvas.loadFromJSON(this.savedPayload);

        // Make sure all loaded objects are selectable and evented
        const objects = this.canvas.getObjects();
        objects.forEach((obj) => {
          obj.selectable = true;
          obj.evented = true;
          obj.hoverCursor = 'move';
          obj.setCoords();
        });
      } catch (err) {
        console.error('Failed to load JSON onto editor canvas', err);
      }
    }

    // Add background image to canvas (so it is guaranteed to be present even after loadFromJSON)
    this.backgroundImageObject = fabricImg;
    this.canvas.add(fabricImg);
    this.canvas.sendObjectToBack(fabricImg);

    this.fitImage();

    this.updateLayersList();
  }

  private fitImage(): void {
    if (!this.canvas || !this.backgroundImageObject) return;

    const width = this.canvas.getWidth();
    const height = this.canvas.getHeight();

    const imgWidth = this.backgroundImageObject.width || 800;
    const imgHeight = this.backgroundImageObject.height || 600;

    const scaleX = width / imgWidth;
    const scaleY = height / imgHeight;
    // Fit factor has less initial zoom, e.g. 0.75 instead of 0.9 as requested
    const scale = Math.min(scaleX, scaleY) * 0.75;

    const translateX = (width - imgWidth * scale) / 2;
    const translateY = (height - imgHeight * scale) / 2;

    this.canvas.setViewportTransform([scale, 0, 0, scale, translateX, translateY]);
    this.canvas.renderAll();
  }

  private async handleResize(): Promise<void> {
    const container = this.canvasContainerElement?.nativeElement;
    if (!this.canvas || !container) return;

    const newWidth = container.clientWidth || 800;
    const newHeight = container.clientHeight || 600;

    if (this.canvas.getWidth() !== newWidth || this.canvas.getHeight() !== newHeight) {
      this.canvas.setDimensions({ width: newWidth, height: newHeight });
      this.fitImage();
    }
  }

  // Toolbar Actions
  protected setTool(tool: 'select' | 'rect' | 'polygon'): void {
    if (this.isDrawingPolygon) {
      this.cancelPolygonDrawing();
    }
    this.activeTool.set(tool);
  }

  protected selectPreset(preset: ColorPreset): void {
    this.selectedPresetName.set(preset.name);
    this.strokeColor.set(preset.stroke);
    this.fillColor.set(preset.fill);
    this.fillOpacity.set(0.2); // Set default preset opacity
    this.strokeWidth.set(3); // Set default preset width
    this.updateSelectedObjectStyle();
  }

  protected onStrokeColorChange(event: Event): void {
    const target = event.target as HTMLInputElement;
    this.strokeColor.set(target.value);
    this.selectedPresetName.set('Custom');
    this.updateSelectedObjectStyle();
  }

  protected onFillColorChange(event: Event): void {
    const target = event.target as HTMLInputElement;
    this.fillColor.set(target.value);
    this.selectedPresetName.set('Custom');
    this.updateSelectedObjectStyle();
  }

  protected onOpacityChange(event: Event): void {
    const target = event.target as HTMLInputElement;
    this.fillOpacity.set(parseFloat(target.value));
    this.updateSelectedObjectStyle();
  }

  protected onStrokeWidthChange(event: Event): void {
    const target = event.target as HTMLInputElement;
    this.strokeWidth.set(parseInt(target.value, 10));
    this.updateSelectedObjectStyle();
  }

  protected deleteSelected(): void {
    if (!this.canvas) return;
    const activeObjects = this.canvas.getActiveObjects();
    if (activeObjects.length > 0) {
      activeObjects.forEach((obj) => this.canvas!.remove(obj));
      this.canvas.discardActiveObject();
      this.canvas.renderAll();
      this.isObjectSelected.set(false);
    }
  }

  protected clearAll(): void {
    if (!this.canvas) return;
    if (confirm('Are you sure you want to clear all shapes?')) {
      this.canvas.clear();
      this.canvas.renderAll();
      this.isObjectSelected.set(false);
      if (this.isDrawingPolygon) {
        this.polygonPoints = [];
        this.isDrawingPolygon = false;
      }
      this.autoSave();
    }
  }

  private autoSave(): void {
    if (!this.canvas || this.isDrawingRect || this.isDrawingPolygon) return;

    const payload = this.canvas.toJSON();
    this.save.emit(JSON.stringify(payload));
  }

  // Layers List Methods
  private updateLayersList(): void {
    if (!this.canvas) {
      this.layers.set([]);
      this.layersChange.emit([]);
      return;
    }

    const objects = this.canvas.getObjects();
    // Exclude temp visual aids and background image from layers panel
    const shapesOnly = objects.filter(
      (obj) =>
        obj !== this.activePolyline &&
        obj !== this.guideLine &&
        obj !== this.startCircle &&
        obj !== this.backgroundImageObject
    );

    const activeObjects = this.canvas.getActiveObjects();

    const mappedLayers = shapesOnly.map((obj, index) => {
      const type = obj.type === 'rect' ? 'Rectangle' : 'Polygon';
      return {
        fabricObj: obj,
        name: `${type} ${index + 1}`,
        type: obj.type,
        visible: obj.visible,
        stroke: obj.stroke || '#000000',
        isActive: activeObjects.includes(obj),
      };
    });

    this.layers.set(mappedLayers);
    this.layersChange.emit(mappedLayers);
  }

  selectLayer(layer: any): void {
    if (!this.canvas) return;
    const obj = layer.fabricObj;
    this.canvas.setActiveObject(obj);
    this.canvas.renderAll();
    this.updateLayersList();
  }

  toggleLayerVisibility(event: Event, layer: any): void {
    event.stopPropagation();
    if (!this.canvas) return;

    const obj = layer.fabricObj;
    obj.set({ visible: !obj.visible });

    // Deselect if active object is hidden
    if (!obj.visible && this.canvas.getActiveObject() === obj) {
      this.canvas.discardActiveObject();
    }

    this.canvas.renderAll();
    this.updateLayersList();
    this.autoSave();
  }

  deleteLayer(event: Event, layer: any): void {
    event.stopPropagation();
    if (!this.canvas) return;

    const obj = layer.fabricObj;
    this.canvas.remove(obj);
    this.canvas.discardActiveObject();
    this.canvas.renderAll();
    this.updateLayersList();
    this.autoSave();
  }



  // Event handlers for Canvas Drawing / Panning
  private onMouseDown(opt: any): void {
    const tool = this.activeTool();

    // PANNING ACTION: If holding spacebar or dragging background in select mode
    if (this.isSpacePressed || (tool === 'select' && !opt.target)) {
      this.isPanning = true;
      this.lastPosX = opt.e.clientX;
      this.lastPosY = opt.e.clientY;
      if (this.canvas) {
        this.canvas.defaultCursor = 'grabbing';
      }
      return;
    }

    // If mouse select tool is active, do not initiate any drawing logic!
    if (tool === 'select') {
      return;
    }

    // CRITICAL: If click lands on an existing object, let Fabric selection / dragging take over.
    // Do not draw a new shape!
    if (opt.target && opt.target !== this.startCircle) {
      return;
    }

    const point = opt.scenePoint ? this.clampPoint(opt.scenePoint) : null;
    if (!point || !this.canvas) return;

    if (tool === 'rect') {
      this.isDrawingRect = true;
      this.rectStartPoint = { x: point.x, y: point.y };

      const fillColor = this.hexToRgba(this.fillColor(), this.fillOpacity());

      this.activeRectObject = new Rect({
        left: point.x,
        top: point.y,
        width: 0,
        height: 0,
        fill: fillColor,
        stroke: this.strokeColor(),
        strokeWidth: this.strokeWidth(),
        selectable: false,
        evented: false,
        hoverCursor: 'move',
        hasBorders: true,
        hasControls: true,
      });

      this.canvas.discardActiveObject();
      this.canvas.add(this.activeRectObject);
      this.canvas.renderAll();
    } else if (tool === 'polygon') {
      const strokeColor = this.strokeColor();

      // If we clicked near the start circle and have at least 3 points, close it!
      if (this.polygonPoints.length >= 3 && this.isNearStartPoint(point)) {
        this.finishPolygonDrawing();
        return;
      }

      this.isDrawingPolygon = true;
      this.polygonPoints.push({ x: point.x, y: point.y });

      // Draw start point indicator circle
      if (this.polygonPoints.length === 1) {
        this.canvas.discardActiveObject();
        this.startCircle = new Circle({
          left: point.x - 6,
          top: point.y - 6,
          radius: 6,
          fill: '#ffffff',
          stroke: strokeColor,
          strokeWidth: 2,
          selectable: false,
          evented: false,
        });
        this.canvas.add(this.startCircle);
      }

      this.updatePolygonVisuals();
    }
  }

  private onMouseMove(opt: any): void {
    // PANNING RUNTIME: Move viewport transform based on drag offset
    if (this.isPanning && this.canvas) {
      const e = opt.e;
      const vpt = this.canvas.viewportTransform ? [...this.canvas.viewportTransform] : [1, 0, 0, 1, 0, 0];
      vpt[4] += e.clientX - this.lastPosX;
      vpt[5] += e.clientY - this.lastPosY;
      this.canvas.setViewportTransform(vpt as [number, number, number, number, number, number]);
      this.canvas.requestRenderAll();
      this.lastPosX = e.clientX;
      this.lastPosY = e.clientY;
      return;
    }

    const point = opt.scenePoint ? this.clampPoint(opt.scenePoint) : null;
    if (!point || !this.canvas) return;

    const tool = this.activeTool();

    if (tool === 'rect' && this.isDrawingRect && this.activeRectObject) {
      const left = Math.min(this.rectStartPoint.x, point.x);
      const top = Math.min(this.rectStartPoint.y, point.y);
      const width = Math.abs(this.rectStartPoint.x - point.x);
      const height = Math.abs(this.rectStartPoint.y - point.y);

      this.activeRectObject.set({ left, top, width, height });
      this.activeRectObject.setCoords();
      this.canvas.renderAll();
    } else if (tool === 'polygon' && this.isDrawingPolygon && this.polygonPoints.length > 0) {
      // Update guide line to cursor
      const lastPoint = this.polygonPoints[this.polygonPoints.length - 1];

      if (this.guideLine) {
        this.canvas.remove(this.guideLine);
      }

      this.guideLine = new Line([lastPoint.x, lastPoint.y, point.x, point.y], {
        stroke: this.strokeColor(),
        strokeWidth: this.strokeWidth(),
        selectable: false,
        evented: false,
        strokeDashArray: [5, 5],
      });
      this.canvas.add(this.guideLine);
      this.canvas.renderAll();
    }
  }

  private onMouseUp(opt: any): void {
    if (this.isPanning) {
      this.isPanning = false;
      if (this.canvas) {
        this.canvas.defaultCursor = this.isSpacePressed ? 'grab' : 'default';
      }
      return;
    }

    if (this.isDrawingRect) {
      this.isDrawingRect = false;
      if (this.activeRectObject) {
        this.activeRectObject.set({
          selectable: true,
          evented: true,
        });
        this.activeRectObject.setCoords();
        this.canvas?.setActiveObject(this.activeRectObject);
        this.activeRectObject = null;
        this.canvas?.renderAll();
        this.autoSave();
      }
    }
  }

  private onDoubleClick(): void {
    if (this.activeTool() === 'polygon' && this.isDrawingPolygon && this.polygonPoints.length >= 3) {
      this.finishPolygonDrawing();
    }
  }

  // Polygon Helpers
  private isNearStartPoint(point: { x: number; y: number }): boolean {
    if (this.polygonPoints.length === 0) return false;
    const start = this.polygonPoints[0];
    const dist = Math.sqrt(Math.pow(point.x - start.x, 2) + Math.pow(point.y - start.y, 2));
    return dist < 12; // 12px threshold
  }

  private updatePolygonVisuals(): void {
    if (!this.canvas) return;

    if (this.activePolyline) {
      this.canvas.remove(this.activePolyline);
    }

    this.activePolyline = new Polyline(this.polygonPoints, {
      stroke: this.strokeColor(),
      strokeWidth: this.strokeWidth(),
      fill: 'transparent',
      selectable: false,
      evented: false,
    });

    this.canvas.add(this.activePolyline);
    this.canvas.renderAll();
  }

  private finishPolygonDrawing(): void {
    if (!this.canvas || this.polygonPoints.length < 3) return;

    const fillColor = this.hexToRgba(this.fillColor(), this.fillOpacity());
    
    const polygon = new Polygon(this.polygonPoints, {
      stroke: this.strokeColor(),
      strokeWidth: this.strokeWidth(),
      fill: fillColor,
      selectable: true,
      hoverCursor: 'move',
      hasBorders: true,
      hasControls: true,
    });

    this.cleanupDrawingObjects();
    this.canvas.add(polygon);
    this.canvas.setActiveObject(polygon);
    polygon.setCoords();

    this.polygonPoints = [];
    this.isDrawingPolygon = false;
    this.canvas.renderAll();
    
    this.autoSave();
  }

  private cancelPolygonDrawing(): void {
    this.cleanupDrawingObjects();
    this.polygonPoints = [];
    this.isDrawingPolygon = false;
    this.canvas?.renderAll();
  }

  private cancelRectDrawing(): void {
    if (this.canvas && this.activeRectObject) {
      this.canvas.remove(this.activeRectObject);
      this.activeRectObject = null;
      this.isDrawingRect = false;
      this.canvas.renderAll();
    }
  }

  private cleanupDrawingObjects(): void {
    if (!this.canvas) return;
    if (this.activePolyline) {
      this.canvas.remove(this.activePolyline);
      this.activePolyline = null;
    }
    if (this.guideLine) {
      this.canvas.remove(this.guideLine);
      this.guideLine = null;
    }
    if (this.startCircle) {
      this.canvas.remove(this.startCircle);
      this.startCircle = null;
    }
  }

  // Sync controls with Canvas
  private onToolChanged(tool: 'select' | 'rect' | 'polygon'): void {
    if (this.canvas) {
      this.canvas.selection = tool === 'select';
      this.canvas.discardActiveObject();
      this.canvas.renderAll();
    }
  }

  private updateSelectedObjectStyle(): void {
    if (!this.canvas) return;

    const activeObj = this.canvas.getActiveObject();
    if (activeObj) {
      const fillColor = this.hexToRgba(this.fillColor(), this.fillOpacity());
      activeObj.set({
        stroke: this.strokeColor(),
        fill: fillColor,
        strokeWidth: this.strokeWidth(),
      });
      this.canvas.renderAll();
      this.autoSave();
    }
  }

  // Utils
  private clampPoint(point: { x: number; y: number }): { x: number; y: number } {
    if (!this.backgroundImageObject) return point;
    const imgWidth = this.backgroundImageObject.width || 800;
    const imgHeight = this.backgroundImageObject.height || 600;
    return {
      x: Math.max(0, Math.min(imgWidth, point.x)),
      y: Math.max(0, Math.min(imgHeight, point.y)),
    };
  }

  private hexToRgba(hex: string, alpha: number): string {
    if (hex.startsWith('rgba')) return hex;
    let c = hex.substring(1);
    if (c.length === 3) {
      c = c[0] + c[0] + c[1] + c[1] + c[2] + c[2];
    }
    const r = parseInt(c.slice(0, 2), 16);
    const g = parseInt(c.slice(2, 4), 16);
    const b = parseInt(c.slice(4, 6), 16);
    return `rgba(${r}, ${g}, ${b}, ${alpha})`;
  }
}
