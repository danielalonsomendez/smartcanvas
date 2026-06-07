import {
  Component,
  ElementRef,
  HostListener,
  input,
  ViewChild,
  AfterViewInit,
  OnDestroy,
  effect,
} from '@angular/core';
import { Canvas } from 'fabric';

@Component({
  selector: 'app-canvas-viewer',
  standalone: true,
  imports: [],
  templateUrl: './canvas-viewer.component.html',
})
export class CanvasViewerComponent implements AfterViewInit, OnDestroy {
  imageSrc = input.required<string>();
  canvasData = input<string | undefined>();

  @ViewChild('viewerCanvas') canvasElement!: ElementRef<HTMLCanvasElement>;
  @ViewChild('bgImage') bgImage!: ElementRef<HTMLImageElement>;

  private canvas: Canvas | null = null;
  private savedPayload: any = null;

  constructor() {
    // React to canvasData changes
    effect(() => {
      const data = this.canvasData();
      if (data) {
        try {
          this.savedPayload = JSON.parse(data);
        } catch (e) {
          console.error('Error parsing canvas data in viewer', e);
          this.savedPayload = null;
        }
      } else {
        this.savedPayload = null;
      }
      this.updateCanvasSize();
    });
  }

  ngAfterViewInit(): void {
    // Canvas is initialized after view init.
    // However, we must wait for the image to load to get its correct displayed size.
  }

  ngOnDestroy(): void {
    if (this.canvas) {
      this.canvas.dispose();
      this.canvas = null;
    }
  }

  @HostListener('window:resize')
  onResize(): void {
    this.updateCanvasSize();
  }

  protected async onImageLoaded(): Promise<void> {
    const imgEl = this.bgImage?.nativeElement;
    if (!imgEl || !this.canvasElement) return;

    const width = imgEl.clientWidth;
    const height = imgEl.clientHeight;

    if (width === 0 || height === 0) {
      // If client dimensions are not ready, retry in next animation frame
      requestAnimationFrame(() => this.onImageLoaded());
      return;
    }

    if (this.canvas) {
      this.canvas.dispose();
    }

    this.canvas = new Canvas(this.canvasElement.nativeElement, {
      width,
      height,
      selection: false,
    });

    await this.updateCanvasSize();
  }

  private async updateCanvasSize(): Promise<void> {
    const imgEl = this.bgImage?.nativeElement;
    if (!this.canvas || !imgEl) return;

    const newWidth = imgEl.clientWidth;
    const newHeight = imgEl.clientHeight;

    if (newWidth === 0 || newHeight === 0) return;

    // Update canvas bounds to match the image element
    this.canvas.setDimensions({ width: newWidth, height: newHeight });

    if (this.savedPayload) {
      const savedWidth = this.savedPayload.width || newWidth;
      const scale = newWidth / savedWidth;

      try {
        await this.canvas.loadFromJSON(this.savedPayload);

        const objects = this.canvas.getObjects();
        objects.forEach((obj) => {
          // Force all objects to be read-only and ignore pointer events
          obj.selectable = false;
          obj.hoverCursor = 'default';
          obj.evented = false;

          // Scale objects proportionally from the baseline when they were saved
          obj.left = (obj.left || 0) * scale;
          obj.top = (obj.top || 0) * scale;
          obj.scaleX = (obj.scaleX || 1) * scale;
          obj.scaleY = (obj.scaleY || 1) * scale;
          obj.setCoords();
        });

        this.canvas.renderAll();
      } catch (err) {
        console.error('Error loading JSON onto viewer canvas', err);
      }
    } else {
      // If no shapes, just clear the canvas
      this.canvas.clear();
      this.canvas.renderAll();
    }
  }
}
