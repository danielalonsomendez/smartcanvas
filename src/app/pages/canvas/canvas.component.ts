import { Component, computed, inject, OnInit, signal, ViewChild } from '@angular/core';
import { Router, ActivatedRoute } from '@angular/router';
import { CanvasEditorComponent, CanvasActions } from '../../components/canvas-editor/canvas-editor.component';
import { CanvasDataComponent } from '../../components/canvas-data/canvas-data.component';
import { HistorySidebarComponent } from '../../components/history-sidebar/history-sidebar.component';
import { IndexedDbService, SavedImage } from '../../services/indexed-db.service';

@Component({
  selector: 'app-canvas',
  standalone: true,
  imports: [CanvasEditorComponent, HistorySidebarComponent, CanvasDataComponent],
  templateUrl: './canvas.component.html',
})
export class CanvasComponent implements OnInit {
  private readonly dbService = inject(IndexedDbService);
  private readonly router = inject(Router);
  private readonly route = inject(ActivatedRoute);

  @ViewChild(CanvasEditorComponent) editorComponent?: CanvasEditorComponent;

  protected readonly savedImages = signal<SavedImage[]>([]);
  protected readonly selectedImageId = signal<number | null>(null);

  protected readonly imageSrc = signal<string | null>(null);
  protected readonly fileName = signal<string | null>(null);
  protected readonly fileSize = signal<string | null>(null);
  protected readonly imageDimensions = signal<{ width: number; height: number } | null>(null);
  protected readonly canvasData = signal<string | undefined>(undefined);

  // Active workspace tab selection ('image' or 'data')
  protected readonly activeWorkspaceTab = signal<'image' | 'data'>('image');

  // Active photo layer items synced from the canvas editor
  protected readonly activeLayers = signal<any[]>([]);

  // Canvas actions bridge — updated after each layersChange event
  protected readonly canvasActions = signal<CanvasActions | null>(null);

  // Active image metadata for the agent's context
  protected readonly imageMetadata = signal<{ name: string; width: number; height: number; size: string } | null>(null);

  async ngOnInit(): Promise<void> {
    await this.loadHistory();
    
    // Subscribe to URL parameter changes to set the active photo state
    this.route.params.subscribe(async (params) => {
      const id = params['id'];
      if (id) {
        const numericId = parseInt(id, 10);
        await this.loadHistory(); // Refresh to check availability
        const image = this.savedImages().find((img) => img.id === numericId);
        if (image) {
          this.setActiveImage(image);
        } else {
          // If image does not exist, fall back to upload list
          this.router.navigate(['/']);
        }
      } else {
        this.clearImage();
      }
    });
  }

  private async loadHistory(): Promise<void> {
    try {
      const history = await this.dbService.getImages();
      this.savedImages.set(history);
    } catch (err) {
      console.error('Failed to load upload history', err);
    }
  }

  protected onFileSelected(file: File): void {
    if (!file.type.startsWith('image/')) {
      alert('Please select an image file.');
      return;
    }

    const formattedSize = this.formatBytes(file.size);
    const reader = new FileReader();

    reader.onload = async (e) => {
      const result = e.target?.result as string;

      const img = new Image();
      img.onload = async () => {
        const dimensions = {
          width: img.naturalWidth,
          height: img.naturalHeight,
        };

        // Save to IndexedDB
        try {
          const saved = await this.dbService.saveImage({
            name: file.name,
            dataUrl: result,
            size: formattedSize,
            width: dimensions.width,
            height: dimensions.height,
          });

          // Refresh list
          await this.loadHistory();
          
          // Navigate to new image route
          this.router.navigate(['/photo', saved.id]);
        } catch (err) {
          console.error('Failed to save image to IndexedDB', err);
          // Fallback to memory-only state if DB fails
          this.imageSrc.set(result);
          this.fileName.set(file.name);
          this.fileSize.set(formattedSize);
          this.imageDimensions.set(dimensions);
          this.canvasData.set(undefined);
        }
      };
      img.src = result;
    };
    reader.readAsDataURL(file);
  }

  protected onSelectImage(image: SavedImage): void {
    this.router.navigate(['/photo', image.id]);
  }

  protected goBackToList(): void {
    this.router.navigate(['/']);
  }

  protected setActiveImage(image: SavedImage): void {
    this.selectedImageId.set(image.id || null);
    this.imageSrc.set(image.dataUrl);
    this.fileName.set(image.name);
    this.fileSize.set(image.size);
    this.imageDimensions.set({
      width: image.width,
      height: image.height,
    });
    this.canvasData.set(image.canvasData);
    this.imageMetadata.set({
      name: image.name,
      width: image.width,
      height: image.height,
      size: image.size,
    });
  }

  protected clearImage(): void {
    this.selectedImageId.set(null);
    this.imageSrc.set(null);
    this.fileName.set(null);
    this.fileSize.set(null);
    this.imageDimensions.set(null);
    this.canvasData.set(undefined);
    this.activeLayers.set([]);
    this.canvasActions.set(null);
    this.imageMetadata.set(null);
  }

  protected async onDeleteHistoryItem(id: number): Promise<void> {
    try {
      await this.dbService.deleteImage(id);
      
      // If we are deleting the currently active image, navigate back to empty state
      if (this.selectedImageId() === id) {
        this.router.navigate(['/']);
      } else {
        await this.loadHistory();
      }
    } catch (err) {
      console.error('Failed to delete image', err);
    }
  }

  protected async onSaveCanvasData(dataJson: string): Promise<void> {
    const activeId = this.selectedImageId();
    if (activeId === null) return;

    try {
      await this.dbService.updateImageCanvasData(activeId, dataJson);
      
      // Refresh upload history listing to reflect the modified records
      await this.loadHistory();
      
      // Update local preview state from the newly saved record
      const updatedImage = this.savedImages().find((img) => img.id === activeId);
      if (updatedImage) {
        this.canvasData.set(updatedImage.canvasData);
      }
    } catch (err) {
      console.error('Failed to update canvas annotations in database', err);
    }
  }

  // Delegate layer sidebar events to CanvasEditorComponent
  protected onSelectLayer(layer: any): void {
    this.editorComponent?.selectLayer(layer);
  }

  protected onToggleLayerVisibility(event: Event, layer: any): void {
    this.editorComponent?.toggleLayerVisibility(event, layer);
  }

  protected onDeleteLayer(event: Event, layer: any): void {
    this.editorComponent?.deleteLayer(event, layer);
  }

  protected onLayersChanged(layers: any[]): void {
    this.activeLayers.set(layers);
    // Refresh the canvasActions reference so the chat panel always has the latest
    if (this.editorComponent) {
      this.canvasActions.set(this.editorComponent.getCanvasActions());
    }
  }

  private formatBytes(bytes: number, decimals = 2): string {
    if (bytes === 0) return '0 Bytes';
    const k = 1024;
    const dm = decimals < 0 ? 0 : decimals;
    const sizes = ['Bytes', 'KB', 'MB', 'GB'];
    const i = Math.floor(Math.log(bytes) / Math.log(k));
    return parseFloat((bytes / Math.pow(k, i)).toFixed(dm)) + ' ' + sizes[i];
  }
}
