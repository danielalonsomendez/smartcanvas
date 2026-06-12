import { Injectable, signal } from '@angular/core';
import { Canvas, Rect, Polygon, FabricImage, Point } from 'fabric';

export interface LayerGeometry {
  x?: number;
  y?: number;
  width?: number;
  height?: number;
  points?: any;
}

export interface LayerInput {
  type: 'rect' | 'polygon';
  name?: string;
  coordinateSystem?: 'pixels' | 'normalized';
  geometry: LayerGeometry;
  stroke?: string;
  fill?: string;
  strokeWidth?: number;
}

@Injectable({
  providedIn: 'root',
})
export class CanvasInteractionService {
  private canvas: Canvas | null = null;
  private bgImage: FabricImage | null = null;

  registerCanvas(canvas: Canvas, bgImage: FabricImage | null): void {
    this.canvas = canvas;
    this.bgImage = bgImage;
  }

  unregisterCanvas(): void {
    this.canvas = null;
    this.bgImage = null;
  }

  getCanvasDimensions(): { width: number; height: number } | null {
    if (!this.bgImage) return null;
    return {
      width: this.bgImage.width || 800,
      height: this.bgImage.height || 600,
    };
  }

  getLayers(): any[] {
    if (!this.canvas) return [];

    const objects = this.canvas.getObjects();
    // Exclude temp visual aids and background image
    const shapesOnly = objects.filter(
      (obj) =>
        obj.type !== 'image' && // Background image has type 'image'
        obj.selectable !== false // Exclude visual assistants like the start point circle
    );

    return shapesOnly.map((obj, index) => {
      const type = obj.type;
      const stroke = obj.stroke || '#000000';
      const fill = obj.fill || 'transparent';
      const strokeWidth = obj.strokeWidth || 3;
      const visible = obj.visible !== false;

      let geometry: LayerGeometry = {};

      if (obj.type === 'rect') {
        const rect = obj as Rect;
        geometry = {
          x: rect.left,
          y: rect.top,
          width: rect.getScaledWidth(),
          height: rect.getScaledHeight(),
        };
      } else if (obj.type === 'polygon') {
        const poly = obj as Polygon;
        const matrix = poly.calcTransformMatrix();
        const absolutePoints = poly.points.map((p) => {
          const point = new Point(p.x - poly.pathOffset.x, p.y - poly.pathOffset.y);
          const transformed = point.transform(matrix);
          return { x: transformed.x, y: transformed.y };
        });
        geometry = {
          points: absolutePoints,
        };
      }

      return {
        index,
        name: (obj as any).name || `${type === 'rect' ? 'Rectangle' : 'Polygon'} ${index + 1}`,
        type,
        visible,
        stroke,
        fill,
        strokeWidth,
        geometry,
      };
    });
  }

  private normalizePoints(pointsInput: any): { x: number; y: number }[] {
    if (!pointsInput) return [];

    // Case 1: If it's a string (e.g. "100,200 150,250 200,200" or "100,200,150,250...")
    if (typeof pointsInput === 'string') {
      const numbers = pointsInput
        .split(/[\s,]+/) // Split by spaces or commas
        .map(num => parseFloat(num.trim()))
        .filter(num => !isNaN(num));
      
      const points: { x: number; y: number }[] = [];
      for (let i = 0; i < numbers.length - 1; i += 2) {
        points.push({ x: numbers[i], y: numbers[i + 1] });
      }
      return points;
    }

    // Case 2: If it's an array
    if (Array.isArray(pointsInput)) {
      // Subcase 2a: Array of objects with x and y: [{x: 100, y: 200}]
      if (pointsInput.every(p => p && typeof p === 'object' && 'x' in p && 'y' in p)) {
        return pointsInput.map(p => ({ x: Number(p.x), y: Number(p.y) }));
      }

      // Subcase 2b: Array of coordinate pairs: [[100, 200], [150, 250]]
      if (pointsInput.every(p => Array.isArray(p) && p.length >= 2)) {
        return pointsInput.map(p => ({ x: Number(p[0]), y: Number(p[1]) }));
      }

      // Subcase 2c: Flat array of numbers: [100, 200, 150, 250, ...]
      const isAllNumbers = pointsInput.every(p => typeof p === 'number');
      if (isAllNumbers) {
        const points: { x: number; y: number }[] = [];
        for (let i = 0; i < pointsInput.length - 1; i += 2) {
          points.push({ x: Number(pointsInput[i]), y: Number(pointsInput[i + 1]) });
        }
        return points;
      }
    }

    return [];
  }

  addLayers(layers: LayerInput[]): { success: boolean; addedCount: number; message: string } {
    if (!this.canvas || !this.bgImage) {
      return {
        success: false,
        addedCount: 0,
        message: 'No active canvas found. Please select an image first.',
      };
    }

    const imgWidth = this.bgImage.width || 800;
    const imgHeight = this.bgImage.height || 600;

    let addedCount = 0;

    for (const layer of layers) {
      const isNorm = layer.coordinateSystem === 'normalized';
      const stroke = layer.stroke || '#4f46e5';
      const fill = layer.fill || 'rgba(129, 140, 248, 0.2)';
      const strokeWidth = layer.strokeWidth || 3;

      if (layer.type === 'rect') {
        let { x, y, width, height } = layer.geometry;
        if (x === undefined || y === undefined || width === undefined || height === undefined) {
          continue;
        }

        if (isNorm) {
          x = (x / 1000) * imgWidth;
          y = (y / 1000) * imgHeight;
          width = (width / 1000) * imgWidth;
          height = (height / 1000) * imgHeight;
        }

        const rect = new Rect({
          left: x,
          top: y,
          width: width,
          height: height,
          stroke: stroke,
          fill: fill,
          strokeWidth: strokeWidth,
          selectable: true,
          hoverCursor: 'move',
          hasBorders: true,
          hasControls: true,
        });
        (rect as any).name = layer.name;

        this.canvas.add(rect);
        addedCount++;
      } else if (layer.type === 'polygon') {
        let points = this.normalizePoints(layer.geometry.points);
        if (!points || points.length < 3) {
          continue;
        }

        if (isNorm) {
          points = points.map((p) => ({
            x: (p.x / 1000) * imgWidth,
            y: (p.y / 1000) * imgHeight,
          }));
        }

        const poly = new Polygon(points, {
          stroke: stroke,
          fill: fill,
          strokeWidth: strokeWidth,
          selectable: true,
          hoverCursor: 'move',
          hasBorders: true,
          hasControls: true,
        });
        (poly as any).name = layer.name;

        this.canvas.add(poly);
        addedCount++;
      }
    }

    if (addedCount > 0) {
      this.canvas.renderAll();
      // Fire 'object:added' event to notify parent canvas and triggers autoSave
      this.canvas.fire('object:added');
    }

    return {
      success: true,
      addedCount,
      message: `Successfully added ${addedCount} layer(s) to the canvas.`,
    };
  }

  addRectangles(rectangles: any[], coordinateSystem?: 'pixels' | 'normalized'): { success: boolean; addedCount: number; message: string } {
    const layers = rectangles.map(r => ({
      type: 'rect' as const,
      name: r.name,
      coordinateSystem: r.coordinateSystem || coordinateSystem,
      geometry: { x: r.x, y: r.y, width: r.width, height: r.height },
      stroke: r.stroke,
      fill: r.fill,
      strokeWidth: r.strokeWidth
    }));
    return this.addLayers(layers);
  }

  addPolygons(polygons: any[], coordinateSystem?: 'pixels' | 'normalized'): { success: boolean; addedCount: number; message: string } {
    const layers = polygons.map(p => ({
      type: 'polygon' as const,
      name: p.name,
      coordinateSystem: p.coordinateSystem || coordinateSystem,
      geometry: { points: p.points },
      stroke: p.stroke,
      fill: p.fill,
      strokeWidth: p.strokeWidth
    }));
    return this.addLayers(layers);
  }

  deleteLayers(indices: number[]): { success: boolean; deletedCount: number; message: string } {
    if (!this.canvas) {
      return { success: false, deletedCount: 0, message: 'No active canvas found.' };
    }

    const objects = this.canvas.getObjects();
    const shapesOnly = objects.filter(
      (obj) =>
        obj.type !== 'image' &&
        obj.selectable !== false
    );

    // Sort indices in descending order to avoid shift issues during deletion
    const sortedIndices = [...indices].sort((a, b) => b - a);
    let deletedCount = 0;

    for (const idx of sortedIndices) {
      if (idx >= 0 && idx < shapesOnly.length) {
        const obj = shapesOnly[idx];
        this.canvas.remove(obj);
        deletedCount++;
      }
    }

    if (deletedCount > 0) {
      this.canvas.discardActiveObject();
      this.canvas.renderAll();
      this.canvas.fire('object:removed');
    }

    return {
      success: true,
      deletedCount,
      message: `Successfully deleted ${deletedCount} layer(s) from the canvas.`,
    };
  }

  clearLayers(): { success: boolean; message: string } {
    if (!this.canvas) {
      return { success: false, message: 'No active canvas found.' };
    }

    const objects = this.canvas.getObjects();
    const shapesOnly = objects.filter(
      (obj) =>
        obj.type !== 'image' &&
        obj.selectable !== false
    );

    for (const obj of shapesOnly) {
      this.canvas.remove(obj);
    }

    this.canvas.discardActiveObject();
    this.canvas.renderAll();
    this.canvas.fire('object:removed');

    return {
      success: true,
      message: 'Successfully cleared all layers from the canvas.',
    };
  }
}
